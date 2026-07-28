"""Scheduled jobs API.

A :class:`~app.db.models.Schedule` is a prompt, a cron expression, a timezone, one
workspace and one agent. The tick loop in ``agents/scheduler.py`` owns firing;
this module owns the rows and the one guarantee that makes the loop safe to leave
running: **anything the user can save here parses.** A malformed cron or an unknown
timezone is a 422 with the reason, never a row that makes every tick raise.

``next_fire_at`` is scheduler state, not user input — it is recomputed here on
create and whenever ``cron``, ``timezone`` or ``enabled`` changes, and by the
scheduler after every fire. Disabling a schedule clears it (nothing is ever due),
which is also what stops a re-enabled schedule from immediately reading as
"missed".
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import delete, select, update

from app.agents import scheduler
from app.cron import CronError, next_occurrences
from app.db.models import (
    Agent,
    Schedule,
    ScheduleFireStatus,
    ScheduleRun,
    ScheduleRunType,
    Thread,
    Workspace,
)
from app.db.session import get_session
from app.schemas.schedule import (
    CronPreviewRead,
    CronPreviewRequest,
    ScheduleCreate,
    ScheduleRead,
    ScheduleRunRead,
    ScheduleUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/schedules", tags=["schedules"])

# History is a debugging aid, not an archive: the newest page is all anyone reads.
RUN_HISTORY_LIMIT = 50


async def _get_or_404(schedule_id: str, session: AsyncSession) -> Schedule:
    row = await session.get(Schedule, schedule_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Schedule not found")
    return row


async def _check_targets(
    session: AsyncSession, *, workspace_id: str | None, agent_id: str | None
) -> None:
    """422 on a workspace or agent that doesn't exist.

    Mirrors ``create_thread``. Worth catching on write rather than at fire time: a
    schedule pointed at a deleted workspace fails silently at 3am, and the only
    trace is an ``error`` history row nobody is watching.
    """
    if workspace_id is not None and await session.get(Workspace, workspace_id) is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Unknown workspace_id")
    if agent_id is not None and await session.get(Agent, agent_id) is None:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Unknown agent_id")


async def _last_runs(
    session: AsyncSession, schedule_ids: list[str]
) -> dict[str, ScheduleRun]:
    """Newest attempted fire per schedule, in one query.

    The rail marks a schedule whose last outcome was ``missed``/``skipped``/
    ``error``, so this would otherwise be a request per row. The table is small
    enough that sorting in Python beats a window function that SQLite would only
    partly optimize anyway.
    """
    if not schedule_ids:
        return {}
    rows = (
        (
            await session.execute(
                select(ScheduleRun)
                .where(ScheduleRun.schedule_id.in_(schedule_ids))
                .order_by(ScheduleRun.fired_at)
            )
        )
        .scalars()
        .all()
    )
    # Ascending, so the last write per schedule wins.
    return {row.schedule_id: row for row in rows}


def _to_read(row: Schedule, last_run: ScheduleRun | None) -> ScheduleRead:
    read = ScheduleRead.model_validate(row)
    read.last_run = ScheduleRunRead.model_validate(last_run) if last_run else None
    return read


def _reschedule(row: Schedule) -> None:
    """Recompute ``next_fire_at`` from the row's current cron/timezone/enabled state."""
    row.next_fire_at = scheduler.compute_next_fire(row) if row.enabled else None


@router.get("", response_model=list[ScheduleRead])
async def list_schedules(
    workspace_id: str | None = Query(None),
    session: AsyncSession = Depends(get_session),
) -> list[ScheduleRead]:
    query = select(Schedule).order_by(Schedule.name)
    if workspace_id:
        query = query.where(Schedule.workspace_id == workspace_id)
    rows = list((await session.execute(query)).scalars().all())
    last = await _last_runs(session, [row.id for row in rows])
    return [_to_read(row, last.get(row.id)) for row in rows]


@router.post("", response_model=ScheduleRead, status_code=status.HTTP_201_CREATED)
async def create_schedule(
    payload: ScheduleCreate, session: AsyncSession = Depends(get_session)
) -> ScheduleRead:
    await _check_targets(
        session, workspace_id=payload.workspace_id, agent_id=payload.agent_id
    )
    row = Schedule(**payload.model_dump())
    # A goal fire needs something to evaluate against; fall back to the prompt, the
    # same way a `/goal` turn's condition falls back in ``api/chat.py``.
    if row.run_type is ScheduleRunType.goal and not row.success_criteria.strip():
        row.success_criteria = row.prompt
    _reschedule(row)
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return _to_read(row, None)


# Declared before "/{schedule_id}" so the literal path is matched first.
@router.post("/preview", response_model=CronPreviewRead)
async def preview_cron(payload: CronPreviewRequest) -> CronPreviewRead:
    """The next N occurrences of a candidate expression. No row involved.

    Both fields are already validated by the schema, so a :class:`CronError` here
    would mean the two disagree — report it as a 422 rather than a 500.
    """
    try:
        occurrences = next_occurrences(
            payload.cron,
            payload.timezone,
            after=datetime.now(UTC),
            count=payload.count,
        )
    except CronError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    return CronPreviewRead(
        cron=payload.cron, timezone=payload.timezone, occurrences=occurrences
    )


@router.get("/{schedule_id}", response_model=ScheduleRead)
async def get_schedule(
    schedule_id: str, session: AsyncSession = Depends(get_session)
) -> ScheduleRead:
    row = await _get_or_404(schedule_id, session)
    last = await _last_runs(session, [row.id])
    return _to_read(row, last.get(row.id))


@router.patch("/{schedule_id}", response_model=ScheduleRead)
async def update_schedule(
    schedule_id: str, payload: ScheduleUpdate, session: AsyncSession = Depends(get_session)
) -> ScheduleRead:
    row = await _get_or_404(schedule_id, session)
    await _check_targets(
        session, workspace_id=payload.workspace_id, agent_id=payload.agent_id
    )
    fields = payload.model_dump(exclude_unset=True)
    for key, value in fields.items():
        setattr(row, key, value)
    if row.run_type is ScheduleRunType.goal and not row.success_criteria.strip():
        row.success_criteria = row.prompt
    # Only these three change *when* it fires. Recomputing on every save would
    # push the next fire out whenever the user edited the prompt or the name.
    if {"cron", "timezone", "enabled"} & fields.keys():
        _reschedule(row)
    row.updated_at = datetime.now(UTC)
    session.add(row)
    await session.commit()
    await session.refresh(row)
    last = await _last_runs(session, [row.id])
    return _to_read(row, last.get(row.id))


@router.delete("/{schedule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_schedule(
    schedule_id: str, session: AsyncSession = Depends(get_session)
) -> None:
    """Delete the schedule and its history. Conversations it created are kept.

    Those transcripts are the record of work that actually happened — deleting them
    with the schedule would throw away the output the user came for.

    But they can't keep pointing at a schedule that no longer exists. A thread with
    a ``schedule_id`` is deliberately hidden from its workspace's conversation list
    (see ``list_threads``), and the Schedules page is where it would otherwise be
    browsed — so leaving the id set would make every run this schedule ever produced
    unreachable outside a saved URL. Clearing it hands them back to the workspace as
    ordinary conversations, which is what they are.
    """
    row = await _get_or_404(schedule_id, session)
    await session.execute(
        update(Thread).where(Thread.schedule_id == row.id).values(schedule_id=None)
    )
    await session.execute(delete(ScheduleRun).where(ScheduleRun.schedule_id == row.id))
    await session.delete(row)
    await session.commit()


@router.post("/{schedule_id}/run-now", response_model=ScheduleRunRead)
async def run_schedule_now(
    schedule_id: str, session: AsyncSession = Depends(get_session)
) -> ScheduleRunRead:
    """Fire immediately, without touching ``next_fire_at``.

    A manual test of a schedule must not move its clock — the point is to see what
    tonight's run will do, not to consume tonight's slot.
    """
    row = await _get_or_404(schedule_id, session)
    scheduled_next = row.next_fire_at
    outcome = await scheduler.fire(session, row, now=datetime.now(UTC))
    # ``fire`` rolls the clock forward, which is right for a real tick and wrong
    # here. Restore it (and the enabled/disabled distinction that comes with it).
    row.next_fire_at = scheduled_next
    session.add(row)
    await session.commit()
    await session.refresh(outcome)
    if outcome.status is ScheduleFireStatus.skipped:
        raise HTTPException(
            status.HTTP_409_CONFLICT, "This schedule already has a run in flight"
        )
    if outcome.status is ScheduleFireStatus.error:
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY, outcome.detail or "The run failed to start"
        )
    return ScheduleRunRead.model_validate(outcome)


@router.get("/{schedule_id}/runs", response_model=list[ScheduleRunRead])
async def list_schedule_runs(
    schedule_id: str,
    limit: int = Query(RUN_HISTORY_LIMIT, ge=1, le=200),
    session: AsyncSession = Depends(get_session),
) -> list[ScheduleRunRead]:
    """History, newest first. Each row carries the thread it opened, so the UI can
    link straight into the conversation."""
    await _get_or_404(schedule_id, session)
    rows = (
        (
            await session.execute(
                select(ScheduleRun)
                .where(ScheduleRun.schedule_id == schedule_id)
                .order_by(ScheduleRun.fired_at.desc())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    return [ScheduleRunRead.model_validate(row) for row in rows]
