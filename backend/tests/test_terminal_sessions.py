"""The PTY session registry: re-attach, replay, pre-warm, and reaping.

These fork real shells rather than mocking ``pty``. The whole point of the module
is process lifetime — that a child survives a detach, that a release actually
reaps it, that EOF is noticed — and none of that is true of a fake. ``/bin/sh``
keeps it cheap: the user's ``$SHELL`` may spend seconds in its rc files, which is
the very cost the pre-warming exists to hide and not something to pay per test.
"""

from __future__ import annotations

import asyncio
import os

import pytest

from app import terminal_sessions
from app.terminal_sessions import Session, sessions


@pytest.fixture(autouse=True)
def _fast_shell(monkeypatch):
    """Fork ``/bin/sh``, not whatever the developer's login shell is."""
    monkeypatch.setenv("SHELL", "/bin/sh")


@pytest.fixture(autouse=True)
async def _clean_registry():
    """The registry is a module-level singleton; no test may leak a shell."""
    yield
    await sessions.shutdown()


async def _wait_for(predicate, timeout: float = 5.0) -> None:
    """Spin the loop until ``predicate`` holds — the PTY reader is loop-driven."""
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("timed out waiting for PTY output")
        await asyncio.sleep(0.02)


async def _wait_for_exit(queue: asyncio.Queue, timeout: float = 5.0) -> None:
    """Consume output until the ``None`` sentinel says the child is gone."""
    async with asyncio.timeout(timeout):
        while await queue.get() is not None:
            pass


def _alive(pid: int) -> bool:
    """Whether ``pid`` is still a process we could signal (zombies count as gone)."""
    try:
        return os.waitpid(pid, os.WNOHANG) == (0, 0)
    except ChildProcessError:
        return False


async def test_reattach_keeps_the_same_shell(tmp_path):
    """The core promise: detaching does not kill, and re-attaching replays."""
    session, _, _ = sessions.attach("pane-1", None, str(tmp_path), 80, 24)
    pid = session.pid

    sessions.write(session, b"echo marker-alpha\n")
    await _wait_for(lambda: b"marker-alpha" in session.buffer)

    sessions.detach(session)
    assert not session.attached
    assert _alive(pid), "detach must not reap the shell"

    # Output produced while nobody was watching still lands in the ring.
    sessions.write(session, b"echo marker-beta\n")
    await _wait_for(lambda: b"marker-beta" in session.buffer)

    same, replay, _ = sessions.attach("pane-1", None, str(tmp_path), 80, 24)
    assert same.pid == pid
    assert b"marker-alpha" in replay
    assert b"marker-beta" in replay


async def test_release_reaps_and_is_idempotent(tmp_path):
    session, _, _ = sessions.attach("pane-2", None, str(tmp_path), 80, 24)
    pid = session.pid

    assert sessions.release("pane-2") is True
    await _wait_for(lambda: not _alive(pid))
    # A pane closed twice, or closed after the sweeper got there first.
    assert sessions.release("pane-2") is False


async def test_release_lets_the_shell_run_its_exit_handling(tmp_path):
    """A released shell is hung up, not shot — it gets to finish shutting down.

    The regression this guards is nastier than it looks. Closing the PTY master
    raises `SIGHUP`, and an interactive shell answers that by saving its history;
    zsh does so under a symlink lock at `$HISTFILE.LOCK`. `SIGKILL` in the middle
    of that leaves the lock behind, and from then on *every* `zsh -i` on the
    machine — Lursor's or the user's own — blocks for ~10s at startup waiting on a
    lock whose owner is long dead. It presented as pre-warmed shells that never
    printed a prompt.

    A trap on HUP stands in for the history save, and it deliberately takes a
    moment: a trap that returned instantly would win the race against even an
    immediate `SIGKILL`, and the test would pass with the bug still in place.
    """
    marker = tmp_path / "hup-handler-ran"
    session, _, _ = sessions.attach("pane-hup", None, str(tmp_path), 80, 24)

    sessions.write(session, f"trap 'sleep 0.5; touch {marker}; exit 0' HUP\n".encode())
    sessions.write(session, b"echo TRAP-ARMED\n")
    # Twice: the shell echoes the command back, then runs it.
    await _wait_for(lambda: session.buffer.count(b"TRAP-ARMED") >= 2)

    sessions.release("pane-hup")

    await _wait_for(lambda: marker.exists())
    await _wait_for(lambda: not _alive(session.pid))


async def test_ring_buffer_trims_at_a_line_boundary(monkeypatch):
    """Over the cap, whole lines go — never the middle of an escape sequence."""
    monkeypatch.setattr(terminal_sessions, "_BUFFER_CAP", 32)
    session = Session(
        id="s", workspace_id=None, cwd="/", pid=0, master_fd=-1, cols=80, rows=24
    )

    for i in range(20):
        session._append(f"line-{i:02d}\n".encode())

    assert len(session.buffer) <= 32
    # Trimming landed on a boundary: the ring starts at the head of a line.
    assert session.buffer.startswith(b"line-")
    assert b"line-19\n" in session.buffer


async def test_ring_buffer_survives_a_line_longer_than_the_cap(monkeypatch):
    """A full-screen app can paint without ever emitting a newline."""
    monkeypatch.setattr(terminal_sessions, "_BUFFER_CAP", 32)
    session = Session(
        id="s", workspace_id=None, cwd="/", pid=0, master_fd=-1, cols=80, rows=24
    )

    session._append(b"x" * 200)
    assert len(session.buffer) == 32


async def test_sweep_reaps_idle_but_never_attached(tmp_path):
    attached, _, _ = sessions.attach("pane-live", None, str(tmp_path), 80, 24)
    idle, _, _ = sessions.attach("pane-idle", None, str(tmp_path), 80, 24)
    sessions.detach(idle)

    # Just short of the TTL, then just past it.
    now = idle.detached_at
    assert sessions.sweep(now=now + terminal_sessions._IDLE_TTL - 1) == []
    assert sessions.sweep(now=now + terminal_sessions._IDLE_TTL + 1) == ["pane-idle"]

    await _wait_for(lambda: not _alive(idle.pid))
    assert _alive(attached.pid), "an attached session is never swept"


async def test_prewarm_is_claimed_by_the_first_attach(tmp_path):
    warm = sessions.prewarm("ws-1", str(tmp_path), 80, 24)
    assert warm is not None
    # Idempotent: opening the same workspace again must not fork a second shell.
    assert sessions.prewarm("ws-1", str(tmp_path), 80, 24) is warm

    # Let it get as far as its prompt, the way it would before a click arrives.
    await _wait_for(lambda: len(warm.buffer) > 0)

    session, _, _ = sessions.attach("pane-3", "ws-1", str(tmp_path), 120, 40)
    assert session.pid == warm.pid, "the attach should adopt the warm shell"
    assert session.id == "pane-3"
    assert session.claimed

    # And it is no longer on offer — a second pane gets its own shell.
    other, _, _ = sessions.attach("pane-4", "ws-1", str(tmp_path), 80, 24)
    assert other.pid != warm.pid


async def test_claiming_at_a_new_size_drops_the_prompt_drawn_at_the_old_one(tmp_path):
    """A pre-warmed prompt is only replayable at the size it was drawn for.

    The shell wraps its prompt in erase-to-end-of-line sequences sized to the
    terminal it thinks it has. Replay that into a narrower pane and the padding
    strands itself as a row of debris above the real prompt — which is what "a
    strange line of symbols at the top of my terminal" was. Nobody has seen this
    output, so it is dropped and the resize's SIGWINCH repaints it.
    """
    warm = sessions.prewarm("ws-size", str(tmp_path), 80, 24)
    assert warm is not None
    await _wait_for(lambda: len(warm.buffer) > 0)

    _, replay, _ = sessions.attach("pane-narrow", "ws-size", str(tmp_path), 120, 40)
    assert replay == b"", "output drawn at 80x24 must not be replayed into 120x40"
    assert (warm.cols, warm.rows) == (120, 40)


async def test_claiming_at_the_same_size_keeps_the_prompt(tmp_path):
    """The other half: matching geometry means the prompt is genuinely valid."""
    warm = sessions.prewarm("ws-same", str(tmp_path), 100, 30)
    assert warm is not None
    await _wait_for(lambda: len(warm.buffer) > 0)

    _, replay, _ = sessions.attach("pane-same", "ws-same", str(tmp_path), 100, 30)
    assert replay, "a prompt drawn at this exact size is worth showing"


async def test_reattaching_at_a_new_size_keeps_the_scrollback(tmp_path):
    """Resizing a pane must never cost an established session its history."""
    session, _, _ = sessions.attach("pane-hist", None, str(tmp_path), 80, 24)
    sessions.write(session, b"echo marker-kept\n")
    await _wait_for(lambda: b"marker-kept" in session.buffer)
    sessions.detach(session)

    _, replay, _ = sessions.attach("pane-hist", None, str(tmp_path), 120, 40)
    assert b"marker-kept" in replay


async def test_prewarm_is_not_claimed_across_workspaces_or_directories(tmp_path):
    warm = sessions.prewarm("ws-1", str(tmp_path), 80, 24)
    assert warm is not None

    other_ws, _, _ = sessions.attach("pane-5", "ws-2", str(tmp_path), 80, 24)
    assert other_ws.pid != warm.pid

    # Same workspace, but its path moved since the pre-warm.
    moved = tmp_path / "moved"
    moved.mkdir()
    relocated, _, _ = sessions.attach("pane-6", "ws-1", str(moved), 80, 24)
    assert relocated.pid != warm.pid


async def test_unclaimed_prewarm_expires_on_the_short_ttl(tmp_path):
    warm = sessions.prewarm("ws-1", str(tmp_path), 80, 24)
    assert warm is not None

    # Past the warm TTL but well short of the idle one: never looked at, so it
    # goes early.
    now = warm.created_at + terminal_sessions._WARM_TTL + 1
    assert now < warm.created_at + terminal_sessions._IDLE_TTL
    assert sessions.sweep(now=now) == [warm.id]
    await _wait_for(lambda: not _alive(warm.pid))


async def test_child_exit_signals_the_attached_client(tmp_path):
    session, _, queue = sessions.attach("pane-7", None, str(tmp_path), 80, 24)
    pid = session.pid

    sessions.write(session, b"exit\n")
    await _wait_for_exit(queue)

    assert session.exited
    # Detaching an exited session cleans it up rather than parking it for the TTL.
    sessions.detach(session, queue)
    await _wait_for(lambda: not _alive(pid))


async def test_attaching_over_a_dead_session_starts_a_new_shell(tmp_path):
    """A pane whose shell died gets a fresh one, not an instant EOF."""
    session, _, queue = sessions.attach("pane-8", None, str(tmp_path), 80, 24)
    dead_pid = session.pid
    sessions.write(session, b"exit\n")
    await _wait_for_exit(queue)
    sessions.detach(session, queue)

    revived, replay, _ = sessions.attach("pane-8", None, str(tmp_path), 80, 24)
    assert revived.pid != dead_pid
    assert not revived.exited
    assert replay == b""


async def test_a_stale_detach_cannot_unplug_a_live_reconnect(tmp_path):
    """The reconnect race: the new socket attaches before the old one cleans up."""
    session, _, first = sessions.attach("pane-9", None, str(tmp_path), 80, 24)
    _, _, second = sessions.attach("pane-9", None, str(tmp_path), 80, 24)

    sessions.detach(session, first)  # the departing socket

    assert session.attached, "the surviving connection still owns the session"
    assert session.queue is second


async def test_shutdown_reaps_everything(tmp_path):
    a, _, _ = sessions.attach("pane-a", None, str(tmp_path), 80, 24)
    b, _, _ = sessions.attach("pane-b", None, str(tmp_path), 80, 24)
    sessions.detach(b)
    warm = sessions.prewarm("ws-9", str(tmp_path), 80, 24)
    assert warm is not None

    await sessions.shutdown()

    for pid in (a.pid, b.pid, warm.pid):
        await _wait_for(lambda pid=pid: not _alive(pid))
    assert sessions.sweep() == []
