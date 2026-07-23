"""Tests for :class:`ChatRunManager`'s replay buffer and sticky snapshots.

The reconnect bug: a goal running through a long turn had its single early
``goal_status`` event trimmed out of the size-capped buffer, so a browser that
refreshed mid-turn replayed text/todos but never learned the run was a goal and
dropped out of goal mode. Sticky events fix that.
"""

from __future__ import annotations

from app.agents.chat_run_manager import (
    _MAX_BUFFER_EVENTS,
    _TRIM_CHUNK,
    ChatRunManager,
)


def _replay(mgr: ChatRunManager, thread_id: str) -> list[str]:
    _queue, replay = mgr.subscribe(thread_id)
    return replay


def test_sticky_event_survives_buffer_trim():
    mgr = ChatRunManager()
    tid = "t1"
    mgr.publish(tid, "goal_status:running", sticky_key="goal_status")
    # Flood the buffer well past the trim threshold so the early goal_status line
    # is evicted from the ordinary buffer.
    for i in range(_MAX_BUFFER_EVENTS + _TRIM_CHUNK + 5):
        mgr.publish(tid, f"text:{i}")

    replay = _replay(mgr, tid)
    assert "goal_status:running" not in mgr._buffers[tid]  # trimmed from the buffer
    assert replay[-1] == "goal_status:running"  # but replayed via the sticky snapshot


def test_latest_sticky_wins_and_appears_after_buffer():
    mgr = ChatRunManager()
    tid = "t2"
    mgr.publish(tid, "goal_status:running:0", sticky_key="goal_status")
    mgr.publish(tid, "text:a")
    mgr.publish(tid, "goal_status:running:3", sticky_key="goal_status")

    replay = _replay(mgr, tid)
    # Only the freshest goal status is kept sticky, and it lands after the buffer
    # so it wins over any older copy still lingering there.
    assert replay[-1] == "goal_status:running:3"
    assert replay.count("goal_status:running:3") >= 1


def test_non_sticky_publish_unaffected():
    mgr = ChatRunManager()
    tid = "t3"
    mgr.publish(tid, "text:a")
    mgr.publish(tid, "text:b")
    assert _replay(mgr, tid) == ["text:a", "text:b"]
    assert mgr._sticky.get(tid, {}) == {}


def test_start_run_clears_prior_sticky():
    mgr = ChatRunManager()
    tid = "t4"
    mgr.publish(tid, "goal_status:running", sticky_key="goal_status")

    async def _noop() -> None:
        return None

    # start_run resets per-run state; a fresh run must not inherit stale goal mode.
    # It spawns a task, but for this unit test we only assert the sticky reset that
    # start_run performs synchronously before scheduling the driver.
    import asyncio

    async def _run() -> None:
        mgr.start_run(tid, _noop)

    asyncio.run(_run())
    assert mgr._sticky.get(tid, {}) == {}
