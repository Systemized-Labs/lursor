"""Live terminal over a WebSocket, backed by a real PTY.

``GET /api/terminal/ws`` (WebSocket) spawns an interactive shell in a
pseudo-terminal rooted at a workspace's directory and pipes it to the browser:

- binary client frames are raw keystrokes written straight to the PTY;
- text client frames are JSON control messages (currently ``resize``);
- PTY output is streamed back to the client as binary frames.

The PTY is created with :func:`pty.fork` so the child gets a controlling
terminal (job control, ``Ctrl-C``, ``clear``, full-screen apps all work). The
master fd is read via the event loop's reader callback, so a chatty shell never
blocks the loop. When the shell exits or the socket drops, the child is reaped.

POSIX only (macOS/Linux). Windows would need a ``pywinpty`` backend.
"""

from __future__ import annotations

import asyncio
import contextlib
import fcntl
import json
import os
import pty
import shutil
import signal
import struct
import termios

from fastapi import APIRouter, WebSocket
from starlette.websockets import WebSocketDisconnect, WebSocketState

from app import gitcfg
from app.config import get_settings
from app.db.models import Workspace
from app.db.session import async_session_factory

router = APIRouter(tags=["terminal"])
settings = get_settings()

_READ_CHUNK = 65536


def _set_winsize(fd: int, rows: int, cols: int) -> None:
    """Push a new window size onto the PTY so the child reflows / redraws."""
    with contextlib.suppress(OSError):
        winsize = struct.pack("HHHH", max(rows, 1), max(cols, 1), 0, 0)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)


async def _resolve_cwd(workspace_id: str | None) -> str:
    """Working directory for the shell: the workspace dir, else the root."""
    if workspace_id:
        async with async_session_factory() as session:
            ws = await session.get(Workspace, workspace_id)
            if ws and ws.path and os.path.isdir(ws.path):
                return ws.path
    settings.workspaces_dir.mkdir(parents=True, exist_ok=True)
    return str(settings.workspaces_dir)


def _spawn_shell(cwd: str) -> tuple[int, int]:
    """Fork an interactive login shell attached to a fresh PTY.

    Returns ``(pid, master_fd)``. The child never returns — it execs the shell
    or exits.
    """
    shell = os.environ.get("SHELL") or shutil.which("bash") or "/bin/sh"
    pid, master_fd = pty.fork()
    if pid == 0:  # child
        with contextlib.suppress(OSError):
            os.chdir(cwd)
        os.environ["TERM"] = "xterm-256color"
        os.environ["COLORTERM"] = "truecolor"
        # If a GitHub account is connected, point git at Lursor's isolated
        # config so clone/push/pull authenticate here too — without touching
        # the user's real ~/.gitconfig.
        os.environ.update(gitcfg.config_env())
        try:
            os.execvp(shell, [shell, "-i"])
        except OSError:
            os._exit(127)
    return pid, master_fd


@router.websocket("/terminal/ws")
async def terminal_ws(websocket: WebSocket, workspace_id: str | None = None) -> None:
    await websocket.accept()
    cwd = await _resolve_cwd(workspace_id)
    pid, master_fd = _spawn_shell(cwd)

    loop = asyncio.get_running_loop()
    os.set_blocking(master_fd, False)
    queue: asyncio.Queue[bytes | None] = asyncio.Queue()

    def _on_readable() -> None:
        """Drain the PTY into the queue; enqueue ``None`` on EOF (shell exited)."""
        try:
            data = os.read(master_fd, _READ_CHUNK)
        except (OSError, BlockingIOError):
            data = b""
        if data:
            queue.put_nowait(data)
        else:
            loop.remove_reader(master_fd)
            queue.put_nowait(None)

    loop.add_reader(master_fd, _on_readable)

    async def _pump_output() -> None:
        """Forward PTY bytes to the client until EOF or the socket closes."""
        while True:
            data = await queue.get()
            if data is None:
                break
            with contextlib.suppress(Exception):
                await websocket.send_bytes(data)
        # Shell exited: close the socket so the client shows "[process exited]".
        if websocket.application_state == WebSocketState.CONNECTED:
            with contextlib.suppress(Exception):
                await websocket.close()

    out_task = asyncio.create_task(_pump_output())

    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
            data = message.get("bytes")
            if data is not None:
                os.write(master_fd, data)
                continue
            text = message.get("text")
            if text:
                _handle_control(master_fd, text)
    except WebSocketDisconnect:
        pass
    finally:
        with contextlib.suppress(Exception):
            loop.remove_reader(master_fd)
        out_task.cancel()
        with contextlib.suppress(Exception):
            os.close(master_fd)
        _reap(pid)


def _handle_control(master_fd: int, text: str) -> None:
    """Apply a JSON control frame from the client (resize, etc.)."""
    try:
        obj = json.loads(text)
    except ValueError:
        return
    if obj.get("type") == "resize":
        _set_winsize(master_fd, int(obj.get("rows", 24)), int(obj.get("cols", 80)))


def _reap(pid: int) -> None:
    """Terminate and reap the shell process group so nothing is orphaned."""
    with contextlib.suppress(OSError):
        os.kill(pid, signal.SIGKILL)
    with contextlib.suppress(OSError):
        os.waitpid(pid, 0)
