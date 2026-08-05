"""Live terminal over a WebSocket, backed by a real PTY.

``GET /api/terminal/ws`` (WebSocket) attaches the browser to an interactive
shell running in a pseudo-terminal rooted at a workspace's directory:

- binary client frames are raw keystrokes written straight to the PTY;
- text client frames are JSON control messages (currently ``resize``);
- PTY output is streamed back to the client as binary frames.

**The socket no longer owns the shell.** :mod:`app.terminal_sessions` does — see
that module for why. This one is transport: resolve the workspace directory,
attach to the session named by ``session_id`` (creating, claiming a pre-warmed
shell, or re-attaching as appropriate), replay what the pane missed, and pump
bytes both ways. A dropped socket detaches; it does not kill.

Two REST endpoints sit alongside it: ``POST /api/terminal/prewarm``, which the UI
fires when a workspace opens so the shell's rc files are already loaded by the
time anyone clicks Terminal, and ``DELETE /api/terminal/sessions/{id}``, which
the UI fires when a terminal pane is genuinely closed.

POSIX only (macOS/Linux). Windows would need a ``pywinpty`` backend.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os

from fastapi import APIRouter, Response, WebSocket
from starlette.websockets import WebSocketDisconnect, WebSocketState

from app.config import get_settings
from app.db.models import Workspace
from app.db.session import async_session_factory
from app.terminal_sessions import Session, sessions

router = APIRouter(tags=["terminal"])
settings = get_settings()


async def _resolve_cwd(workspace_id: str | None) -> str:
    """Working directory for the shell: the workspace dir, else the root."""
    if workspace_id:
        async with async_session_factory() as session:
            ws = await session.get(Workspace, workspace_id)
            if ws and ws.path and os.path.isdir(ws.path):
                return ws.path
    settings.workspaces_dir.mkdir(parents=True, exist_ok=True)
    return str(settings.workspaces_dir)


@router.websocket("/terminal/ws")
async def terminal_ws(
    websocket: WebSocket,
    workspace_id: str | None = None,
    session_id: str | None = None,
    cols: int = 80,
    rows: int = 24,
) -> None:
    await websocket.accept()
    cwd = await _resolve_cwd(workspace_id)

    # No `session_id` means a caller that cannot name its pane. It still gets a
    # working shell — it just gets the old behaviour, reaped when the socket
    # drops, because nothing will ever ask for it again.
    ephemeral = not session_id
    sid = session_id or f"anon:{id(websocket)}"

    session, replay, queue = sessions.attach(sid, workspace_id, cwd, cols, rows)

    # Everything the pane missed while it was gone, in one frame. Written before
    # the pump starts so it cannot interleave with live output.
    if replay:
        with contextlib.suppress(Exception):
            await websocket.send_bytes(replay)

    out_task = asyncio.create_task(_pump_output(websocket, queue))

    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break
            data = message.get("bytes")
            if data is not None:
                sessions.write(session, data)
                continue
            text = message.get("text")
            if text:
                _handle_control(session, text)
    except WebSocketDisconnect:
        pass
    finally:
        out_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await out_task
        if ephemeral:
            sessions.release(sid)
        else:
            sessions.detach(session, queue)


async def _pump_output(
    websocket: WebSocket, queue: asyncio.Queue[bytes | None]
) -> None:
    """Forward PTY bytes to the client until the shell exits or the socket goes.

    The ``None`` sentinel is the whole reason this distinguishes anything: a
    socket that simply dropped will be reconnected by the client, so it must not
    be reported as an exit. Only a child that actually died gets the ``exit``
    control frame, and only that frame makes the pane print "[process exited]".
    """
    while True:
        data = await queue.get()
        if data is None:
            break
        with contextlib.suppress(Exception):
            await websocket.send_bytes(data)
    if websocket.application_state == WebSocketState.CONNECTED:
        with contextlib.suppress(Exception):
            await websocket.send_text(json.dumps({"type": "exit"}))
        with contextlib.suppress(Exception):
            await websocket.close()


def _handle_control(session: Session, text: str) -> None:
    """Apply a JSON control frame from the client (resize, etc.)."""
    try:
        obj = json.loads(text)
    except ValueError:
        return
    if obj.get("type") == "resize":
        with contextlib.suppress(TypeError, ValueError):
            sessions.resize(session, int(obj.get("cols", 80)), int(obj.get("rows", 24)))


@router.post("/terminal/prewarm", status_code=204)
async def prewarm_terminal(
    workspace_id: str | None = None, cols: int = 80, rows: int = 24
) -> Response:
    """Start a shell for a workspace ahead of anyone asking for one.

    Idempotent and fire-and-forget: called on every workspace open, and a
    failure just means the next terminal starts cold.
    """
    cwd = await _resolve_cwd(workspace_id)
    sessions.prewarm(workspace_id, cwd, cols, rows)
    return Response(status_code=204)


@router.delete("/terminal/sessions/{session_id}", status_code=204)
async def release_terminal(session_id: str) -> Response:
    """Kill the shell behind a terminal pane the user closed.

    204 for an unknown id too — the caller's intent ("this session should not
    exist") is already satisfied, and a pane closed twice is not an error.
    """
    sessions.release(session_id)
    return Response(status_code=204)
