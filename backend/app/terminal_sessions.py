"""Long-lived PTY sessions, decoupled from the WebSocket that displays them.

Why this exists: a terminal's shell used to live and die with its socket, so
switching workspaces — which tears down and rebuilds every pane — killed the
shell, and coming back spawned a new one in the default directory with no
history and no running processes. A page reload did the same. The fix is to give
a session an identity (the pane id) and an owner that outlives any one
connection.

The registry here owns the PTY: it forks the shell, keeps the master fd's reader
installed for the session's whole life, and accumulates output into a bounded
ring buffer. A client *attaches* (replaying the ring so the pane comes back
looking the way it left), *detaches* without killing anything, and only a real
pane close — or the idle sweeper — reaps the child.

It also keeps one **pre-warmed** shell per workspace. An interactive shell costs
whatever the user's rc files cost (~2s is normal), and all of it is paid before
the first prompt is painted. Starting one in the background when a workspace
opens means the first click on Terminal attaches to a shell that is already
sitting at its prompt.

Modelled on :mod:`app.agents.preview_service`: module-scope state, a lazily
started sweeper that retires when there is nothing left to watch, and TTL
pruning. In-memory only — a backend restart takes the app down with it, so there
is nothing worth persisting.

POSIX only (macOS/Linux), like the endpoint it backs.
"""

from __future__ import annotations

import asyncio
import contextlib
import fcntl
import logging
import os
import pty
import shutil
import signal
import struct
import termios
import time
from dataclasses import dataclass, field

from app import gitcfg

logger = logging.getLogger(__name__)

_READ_CHUNK = 65536
"""Bytes drained from the PTY per readable event."""

_BUFFER_CAP = 512 * 1024
"""Replay ring size. ~5k lines of typical output — enough that a pane coming
back from a workspace switch looks unchanged, small enough that 32 idle sessions
cost single-digit megabytes."""

_IDLE_TTL = 30 * 60
"""Seconds a detached session survives before it is reaped. Long enough to cover
"I went to another workspace for a while", short enough that a forgotten pane
does not hold a shell forever. The explicit release on pane close is the primary
path; this is the backstop for a closed browser tab or a crash."""

_WARM_TTL = 10 * 60
"""Seconds an unclaimed pre-warmed shell survives. Shorter than `_IDLE_TTL`:
nobody has ever looked at it, so there is no state to lose."""

_SWEEP_INTERVAL = 30
"""Sweeper tick. The TTLs are in minutes; polling faster buys nothing."""

_MAX_SESSIONS = 32
"""Hard cap. Past this the least-recently-active *detached* session is evicted,
so a long-running backend cannot accumulate shells without bound. Attached
sessions are never evicted — something is on screen showing them."""

_TERM_GRACE = 2.0
"""Seconds a hung-up shell gets to exit cleanly before it is killed. See
:func:`_reap` — this window is what lets zsh finish saving its history."""


@dataclass
class Session:
    """One PTY and everything needed to re-attach a client to it."""

    id: str
    workspace_id: str | None
    cwd: str
    pid: int
    master_fd: int
    cols: int
    rows: int
    #: Replay ring — raw PTY bytes, escape sequences and all. xterm is a state
    #: machine, so writing this back verbatim reconstructs the screen.
    buffer: bytearray = field(default_factory=bytearray)
    #: Whether a client is currently connected. Not the same as "alive".
    attached: bool = False
    #: When the last client left, for the idle sweep. None while attached.
    detached_at: float | None = None
    #: False for a pre-warmed shell nobody has attached to yet.
    claimed: bool = False
    #: The child has hit EOF. The session lingers only long enough to tell the
    #: attached client why.
    exited: bool = False
    created_at: float = field(default_factory=time.monotonic)
    last_active: float = field(default_factory=time.monotonic)
    #: The attached client's output queue. `None` sentinel means "child exited".
    queue: asyncio.Queue[bytes | None] | None = None

    def _append(self, data: bytes) -> None:
        """Add to the ring, trimming from the front at a line boundary.

        The boundary matters: escape sequences are multi-byte, and cutting
        through the middle of one would leave the replay starting mid-command —
        xterm would swallow the following printable bytes looking for a
        terminator it will never see. Dropping whole lines cannot do that.
        """
        self.buffer.extend(data)
        excess = len(self.buffer) - _BUFFER_CAP
        if excess <= 0:
            return
        cut = self.buffer.find(b"\n", excess)
        # No newline in the tail (a single enormous line, or a full-screen app
        # painting with cursor moves): fall back to the byte cut. Rare, and the
        # alternative is letting the buffer grow without limit.
        del self.buffer[: cut + 1 if cut != -1 else excess]


def _set_winsize(fd: int, rows: int, cols: int) -> None:
    """Push a new window size onto the PTY so the child reflows / redraws."""
    with contextlib.suppress(OSError):
        winsize = struct.pack("HHHH", max(rows, 1), max(cols, 1), 0, 0)
        fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)


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


async def _reap(pid: int) -> None:
    """Wait for a hung-up shell to exit, escalating to ``SIGKILL`` if it won't.

    **Do not shorten this to a bare ``SIGKILL``.** Closing the PTY master raises
    ``SIGHUP`` on the shell, and an interactive shell's response to ``SIGHUP`` is
    to save its history — which zsh does under a symlink lock at
    ``$HISTFILE.LOCK``. Kill it in the middle of that and the lock survives its
    owner, after which *every* later ``zsh -i`` on the machine blocks for ~10s at
    startup retrying a lock nobody holds. Measured, not theorised: it is what
    turned pre-warmed shells into silent ones that never reached a prompt.

    So the shell gets a grace period to exit on its own, and only a shell that
    ignores the hangup is killed.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + _TERM_GRACE
    while loop.time() < deadline:
        try:
            if os.waitpid(pid, os.WNOHANG) != (0, 0):
                return
        except ChildProcessError:
            return  # Already reaped, by us or by the loop's child watcher.
        except OSError:
            return
        await asyncio.sleep(0.05)
    with contextlib.suppress(OSError):
        os.kill(pid, signal.SIGKILL)
    with contextlib.suppress(OSError):
        os.waitpid(pid, 0)


class TerminalSessions:
    """The registry. One instance, at module scope (:data:`sessions`)."""

    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}
        #: workspace key -> id of the pre-warmed session waiting to be claimed.
        self._warm: dict[str, str] = {}
        self._sweeper: asyncio.Task | None = None
        #: In-flight :func:`_reap` tasks. Held so they are not garbage collected
        #: mid-wait, and so :meth:`shutdown` can wait for the shells to be gone.
        self._reaping: set[asyncio.Task] = set()

    # --- lifecycle ---------------------------------------------------------------

    def create(
        self,
        session_id: str,
        workspace_id: str | None,
        cwd: str,
        cols: int,
        rows: int,
    ) -> Session:
        """Fork a shell and register it under ``session_id``.

        The reader goes on **here**, not on attach: a detached shell has to keep
        making progress (a build finishing while you are in another workspace),
        and a pre-warmed one has to be able to reach its prompt before anyone is
        watching.
        """
        pid, master_fd = _spawn_shell(cwd)
        os.set_blocking(master_fd, False)
        session = Session(
            id=session_id,
            workspace_id=workspace_id,
            cwd=cwd,
            pid=pid,
            master_fd=master_fd,
            cols=cols,
            rows=rows,
        )
        _set_winsize(master_fd, rows, cols)
        self._sessions[session_id] = session

        loop = asyncio.get_running_loop()
        loop.add_reader(master_fd, self._on_readable, session)
        self._ensure_sweeper()
        self._enforce_cap()
        return session

    def _on_readable(self, session: Session) -> None:
        """Drain the PTY into the ring (and the attached client's queue)."""
        try:
            data = os.read(session.master_fd, _READ_CHUNK)
        except BlockingIOError:
            return
        except OSError:
            data = b""
        if data:
            session._append(data)
            session.last_active = time.monotonic()
            if session.queue is not None:
                session.queue.put_nowait(data)
            return

        # EOF: the shell is gone.
        session.exited = True
        with contextlib.suppress(Exception):
            asyncio.get_running_loop().remove_reader(session.master_fd)
        if session.queue is not None:
            # Let the attached client learn *why* the socket is about to close,
            # so it reports an exit instead of trying to reconnect forever.
            session.queue.put_nowait(None)
        else:
            self.release(session.id)

    def attach(
        self,
        session_id: str,
        workspace_id: str | None,
        cwd: str,
        cols: int,
        rows: int,
    ) -> tuple[Session, bytes, asyncio.Queue[bytes | None]]:
        """Connect a client to ``session_id``, creating or claiming as needed.

        Returns the session, the bytes to replay, and the queue to pump from.

        Deliberately synchronous and free of ``await``: the reader callback runs
        on this same loop, so taking the replay snapshot and installing the queue
        in one uninterrupted block is what makes it impossible for a chunk
        arriving right now to be either duplicated into both, or dropped between
        them.
        """
        session = self._sessions.get(session_id)
        if session is not None and session.exited:
            # A dead shell under a live pane id: drop it and start over, rather
            # than attaching to something that will EOF immediately.
            self.release(session_id)
            session = None
        if session is None:
            session = self._claim_warm(session_id, workspace_id, cwd, cols, rows)
        if session is None:
            session = self.create(session_id, workspace_id, cwd, cols, rows)

        session.claimed = True
        session.attached = True
        session.detached_at = None
        session.last_active = time.monotonic()

        replay = bytes(session.buffer)
        queue: asyncio.Queue[bytes | None] = asyncio.Queue()
        session.queue = queue

        # After the snapshot, never before. `TIOCSWINSZ` raises `SIGWINCH` in the
        # child, and that is the only thing that makes a full-screen app (vim,
        # htop, a TUI installer) repaint — the one kind of screen a raw byte
        # replay cannot reconstruct on its own.
        self.resize(session, cols, rows)
        return session, replay, queue

    def detach(self, session: Session, queue: asyncio.Queue | None = None) -> None:
        """Disconnect the client. The shell keeps running.

        ``queue`` identifies *which* connection is leaving. A reconnect race can
        briefly have two sockets on one session id — the new one attaches, then
        the old one's cleanup runs — and without this check the departing socket
        would tear down the arriving one's plumbing.
        """
        if queue is not None and session.queue is not queue:
            return
        session.attached = False
        session.queue = None
        session.detached_at = time.monotonic()
        # A shell that exited while attached has nothing left to tell anyone.
        if session.exited:
            self.release(session.id)

    def release(self, session_id: str) -> bool:
        """End a session and forget it. Idempotent — unknown ids are a no-op.

        Returns as soon as the shell has been hung up; the child is reaped by a
        background task, because giving it time to exit cleanly is the whole
        point (see :func:`_reap`).
        """
        session = self._sessions.pop(session_id, None)
        if session is None:
            return False
        if self._warm.get(self._warm_key(session.workspace_id)) == session_id:
            self._warm.pop(self._warm_key(session.workspace_id), None)
        with contextlib.suppress(Exception):
            asyncio.get_running_loop().remove_reader(session.master_fd)
        # Closing the master hangs up the tty, which is the shell's cue to shut
        # down the way it would if you closed a terminal window: save history,
        # HUP its own jobs, exit.
        with contextlib.suppress(OSError):
            os.close(session.master_fd)
        task = asyncio.create_task(_reap(session.pid))
        self._reaping.add(task)
        task.add_done_callback(self._reaping.discard)
        return True

    # --- io ----------------------------------------------------------------------

    def write(self, session: Session, data: bytes) -> None:
        """Forward keystrokes to the PTY."""
        session.last_active = time.monotonic()
        with contextlib.suppress(OSError):
            os.write(session.master_fd, data)

    def resize(self, session: Session, cols: int, rows: int) -> None:
        """Apply a new window size, remembering it for the next attach."""
        session.cols = max(int(cols), 1)
        session.rows = max(int(rows), 1)
        _set_winsize(session.master_fd, session.rows, session.cols)

    # --- pre-warming -------------------------------------------------------------

    @staticmethod
    def _warm_key(workspace_id: str | None) -> str:
        return workspace_id or "_global"

    def prewarm(
        self, workspace_id: str | None, cwd: str, cols: int, rows: int
    ) -> Session | None:
        """Start a shell for ``workspace_id`` so the first attach is instant.

        One at a time per workspace, and never when one is already waiting — this
        is called on every workspace open, including repeat visits.
        """
        key = self._warm_key(workspace_id)
        existing = self._sessions.get(self._warm.get(key, ""))
        if existing is not None and not existing.exited:
            return existing
        session = self.create(
            f"warm:{key}:{time.monotonic_ns()}", workspace_id, cwd, cols, rows
        )
        self._warm[key] = session.id
        return session

    def _claim_warm(
        self, session_id: str, workspace_id: str | None, cwd: str, cols: int, rows: int
    ) -> Session | None:
        """Adopt this workspace's pre-warmed shell under ``session_id``.

        The cwd has to match as well as the workspace: a workspace whose path
        changed between the pre-warm and the attach would otherwise hand back a
        shell sitting in the old directory.
        """
        key = self._warm_key(workspace_id)
        warm_id = self._warm.get(key)
        if warm_id is None:
            return None
        session = self._sessions.get(warm_id)
        if session is None or session.exited or session.cwd != cwd:
            self._warm.pop(key, None)
            return None
        self._warm.pop(key, None)
        # Re-key in place: the pane owns the id from here on.
        self._sessions.pop(warm_id, None)
        session.id = session_id
        self._sessions[session_id] = session

        # A pre-warmed shell has already drawn a prompt, and it drew it at the
        # size we *guessed* rather than the size this pane turned out to be. Those
        # bytes describe a screen of a different width — zsh's prompt is wrapped in
        # erase-to-end-of-line sequences computed for it — so replaying them into a
        # narrower pane leaves the padding behind as a row of debris above the real
        # prompt. (Reported as "a strange line of symbols at the top": whatever the
        # user's prompt happens to emit, stranded.)
        #
        # Nobody has seen this output, so there is nothing to preserve: drop it. The
        # winsize `attach` applies next differs by definition, so the `SIGWINCH` it
        # raises makes the shell repaint itself at the right size.
        #
        # Only for a *claim*. Re-attaching an established session keeps its
        # scrollback whatever the pane's size now is — that history is the whole
        # point, and a reflowed line is a far smaller price than losing it.
        if (session.cols, session.rows) != (cols, rows):
            session.buffer.clear()
        return session

    # --- sweeping ----------------------------------------------------------------

    def _ensure_sweeper(self) -> None:
        if self._sweeper is None or self._sweeper.done():
            self._sweeper = asyncio.create_task(self._sweep_loop())

    async def _sweep_loop(self) -> None:
        try:
            while self._sessions:
                await asyncio.sleep(_SWEEP_INTERVAL)
                self.sweep()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — a dead sweeper must not kill the app
            logger.exception("terminal session sweeper failed")

    def sweep(self, now: float | None = None) -> list[str]:
        """Reap expired sessions. Returns the ids released, for tests."""
        now = time.monotonic() if now is None else now
        doomed: list[str] = []
        for session in list(self._sessions.values()):
            if session.attached:
                continue
            if session.exited:
                doomed.append(session.id)
                continue
            ttl = _IDLE_TTL if session.claimed else _WARM_TTL
            since = session.detached_at if session.claimed else session.created_at
            if since is not None and now - since > ttl:
                doomed.append(session.id)
        for session_id in doomed:
            self.release(session_id)
        return doomed

    def _enforce_cap(self) -> None:
        """Evict least-recently-active detached sessions past the cap."""
        if len(self._sessions) <= _MAX_SESSIONS:
            return
        detached = sorted(
            (s for s in self._sessions.values() if not s.attached),
            key=lambda s: s.last_active,
        )
        for session in detached[: len(self._sessions) - _MAX_SESSIONS]:
            logger.info("evicting idle terminal session %s (cap reached)", session.id)
            self.release(session.id)

    # --- shutdown ----------------------------------------------------------------

    async def shutdown(self) -> None:
        """Reap everything. Called from the app's lifespan on the way out."""
        if self._sweeper is not None:
            self._sweeper.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._sweeper
            self._sweeper = None
        for session_id in list(self._sessions):
            self.release(session_id)
        self._warm.clear()
        # Wait for the shells to actually be gone rather than leaving orphans
        # behind — bounded by `_TERM_GRACE`, and normally instant, since a shell
        # exits on the hangup long before the grace period is up.
        if self._reaping:
            await asyncio.gather(*list(self._reaping), return_exceptions=True)


sessions = TerminalSessions()
