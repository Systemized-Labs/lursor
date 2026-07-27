"""Startup must not leave dead runs looking alive.

Run state lives only in ``chat_run_manager`` (in-memory), so a crash, a code
reload, or the desktop app quitting leaves the thread row frozen in whatever
in-flight status it had — the ``CancelledError`` handler that writes a terminal
status never gets to run. The observed symptom: conversations stuck at
``running`` for over a week, each showing a spinning status pill for a run whose
process was long gone.

These pin the reconciliation's blast radius, which is the subtle part: it must
clear the transient statuses *and* leave ``awaiting_approval`` alone, since a
parked plan is meant to outlive the process and is cleared by the user's next
turn instead.
"""

from __future__ import annotations

import pytest
from sqlmodel import select

from app.api.chat import reconcile_interrupted_runs
from app.db.models import Agent, Thread, ThreadStatus, Workspace
from app.db.session import async_session_factory, init_db


async def _seed_threads(statuses: list[ThreadStatus]) -> list[str]:
    """Create one thread per status; returns their ids in order."""
    await init_db()
    ids: list[str] = []
    async with async_session_factory() as session:
        workspace = Workspace(name="ws", path="/tmp/ws")
        agent = Agent(name="agent", instructions="x")
        session.add(workspace)
        session.add(agent)
        await session.commit()
        await session.refresh(workspace)
        await session.refresh(agent)
        for status in statuses:
            thread = Thread(
                title=f"thread-{status}",
                workspace_id=workspace.id,
                agent_id=agent.id,
                status=status,
            )
            session.add(thread)
            await session.commit()
            await session.refresh(thread)
            ids.append(thread.id)
    return ids


async def _status_of(thread_id: str) -> ThreadStatus:
    async with async_session_factory() as session:
        thread = await session.get(Thread, thread_id)
        return thread.status


@pytest.mark.parametrize("status", [ThreadStatus.running, ThreadStatus.planning])
async def test_interrupted_runs_become_stopped(status):
    """A thread left mid-run is moved to a terminal state."""
    (thread_id,) = await _seed_threads([status])
    assert await reconcile_interrupted_runs() >= 1
    assert await _status_of(thread_id) == ThreadStatus.stopped


async def test_awaiting_approval_survives_restart():
    """A parked plan is NOT a dead run — it must be left untouched.

    ``awaiting_approval`` intentionally persists across restarts: the user
    reviews the plan doc and carries it out with their next turn. Sweeping it up
    with the genuinely-interrupted statuses would silently discard that park.
    """
    (thread_id,) = await _seed_threads([ThreadStatus.awaiting_approval])
    await reconcile_interrupted_runs()
    assert await _status_of(thread_id) == ThreadStatus.awaiting_approval


async def test_terminal_statuses_are_not_rewritten():
    """Threads that already ended keep their own outcome."""
    terminal = [
        ThreadStatus.idle,
        ThreadStatus.completed,
        ThreadStatus.blocked,
        ThreadStatus.failed,
        ThreadStatus.stopped,
    ]
    ids = await _seed_threads(terminal)
    await reconcile_interrupted_runs()
    for thread_id, status in zip(ids, terminal, strict=True):
        assert await _status_of(thread_id) == status


async def test_reconcile_is_idempotent_and_records_a_reason():
    """A second pass finds nothing, and the first explains itself to the user."""
    (thread_id,) = await _seed_threads([ThreadStatus.running])
    assert await reconcile_interrupted_runs() >= 1

    async with async_session_factory() as session:
        thread = await session.get(Thread, thread_id)
        assert "restart" in thread.last_reason.lower()

    # Nothing is left in an in-flight status, so a re-run is a no-op.
    assert await reconcile_interrupted_runs() == 0


async def test_existing_reason_is_preserved():
    """An interrupted run's last known reason is more useful than ours."""
    await init_db()
    async with async_session_factory() as session:
        workspace = Workspace(name="ws2", path="/tmp/ws2")
        agent = Agent(name="agent2", instructions="x")
        session.add(workspace)
        session.add(agent)
        await session.commit()
        await session.refresh(workspace)
        await session.refresh(agent)
        thread = Thread(
            title="has-reason",
            workspace_id=workspace.id,
            agent_id=agent.id,
            status=ThreadStatus.running,
            last_reason="Turn 4: wiring up the filter chips",
        )
        session.add(thread)
        await session.commit()
        await session.refresh(thread)
        thread_id = thread.id

    await reconcile_interrupted_runs()
    async with async_session_factory() as session:
        refreshed = await session.get(Thread, thread_id)
        assert refreshed.status == ThreadStatus.stopped
        assert refreshed.last_reason == "Turn 4: wiring up the filter chips"


async def test_no_in_flight_threads_is_a_noop():
    """The common startup case: nothing to do, no error."""
    await init_db()
    async with async_session_factory() as session:
        result = await session.execute(
            select(Thread).where(
                Thread.status.in_([ThreadStatus.running, ThreadStatus.planning])
            )
        )
        for thread in result.scalars():
            thread.status = ThreadStatus.stopped
            session.add(thread)
        await session.commit()
    assert await reconcile_interrupted_runs() == 0
