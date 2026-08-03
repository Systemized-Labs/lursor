"""Analytics endpoints — token usage and cost aggregations.

Reads the ``usage_records`` table (one row per agent turn, written by
``api/chat.py``) and rolls it up for the dashboard: overall totals, per-model,
per-workspace, and a daily time series. Every endpoint accepts the same optional
filters so the UI can scope any view by workspace, model, agent, kind, or a date
range.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.agents.file_editing import hashline_stats
from app.db.models import UsageRecord, Workspace
from app.db.session import get_session
from app.schemas.analytics import (
    FileEditingStats,
    ModelUsage,
    TimeseriesPoint,
    UsageTotals,
    WorkspaceUsage,
)

router = APIRouter(prefix="/analytics", tags=["analytics"])

# Column aggregates shared by every rollup, in the order UsageTotals expects.
_SUMS = (
    func.count(UsageRecord.id),
    func.coalesce(func.sum(UsageRecord.input_tokens), 0),
    func.coalesce(func.sum(UsageRecord.output_tokens), 0),
    func.coalesce(func.sum(UsageRecord.total_tokens), 0),
    func.coalesce(func.sum(UsageRecord.cache_read_tokens), 0),
    func.coalesce(func.sum(UsageRecord.cache_write_tokens), 0),
    func.coalesce(func.sum(UsageRecord.requests), 0),
    func.coalesce(func.sum(UsageRecord.cost_usd), 0.0),
)


def _totals_from_row(row) -> dict:
    """Map an aggregate row (in ``_SUMS`` order) onto UsageTotals fields."""
    return {
        "records": row[0] or 0,
        "input_tokens": row[1] or 0,
        "output_tokens": row[2] or 0,
        "total_tokens": row[3] or 0,
        "cache_read_tokens": row[4] or 0,
        "cache_write_tokens": row[5] or 0,
        "requests": row[6] or 0,
        "cost_usd": float(row[7] or 0.0),
    }


def _apply_filters(
    stmt,
    *,
    workspace_id: str | None,
    model: str | None,
    agent_id: str | None,
    kind: str | None,
    start: datetime | None,
    end: datetime | None,
):
    """Attach the common WHERE clauses shared by every analytics query."""
    if workspace_id:
        stmt = stmt.where(UsageRecord.workspace_id == workspace_id)
    if model:
        stmt = stmt.where(UsageRecord.model == model)
    if agent_id:
        stmt = stmt.where(UsageRecord.agent_id == agent_id)
    if kind:
        stmt = stmt.where(UsageRecord.kind == kind)
    if start:
        stmt = stmt.where(UsageRecord.created_at >= start)
    if end:
        stmt = stmt.where(UsageRecord.created_at <= end)
    return stmt


# A dependency bundle so each endpoint declares the filters once.
def _filters(
    workspace_id: str | None = Query(None),
    model: str | None = Query(None),
    agent_id: str | None = Query(None),
    kind: str | None = Query(None),
    start: datetime | None = Query(None),
    end: datetime | None = Query(None),
) -> dict:
    return {
        "workspace_id": workspace_id,
        "model": model,
        "agent_id": agent_id,
        "kind": kind,
        "start": start,
        "end": end,
    }


@router.get("/summary", response_model=UsageTotals)
async def usage_summary(
    filters: dict = Depends(_filters),
    session: AsyncSession = Depends(get_session),
) -> UsageTotals:
    """Overall token/cost totals for the filtered slice."""
    stmt = _apply_filters(select(*_SUMS), **filters)
    row = (await session.execute(stmt)).one()
    return UsageTotals(**_totals_from_row(row))


@router.get("/by-model", response_model=list[ModelUsage])
async def usage_by_model(
    filters: dict = Depends(_filters),
    session: AsyncSession = Depends(get_session),
) -> list[ModelUsage]:
    """Token/cost totals grouped by model, biggest spenders first."""
    stmt = _apply_filters(select(UsageRecord.model, *_SUMS), **filters)
    stmt = stmt.group_by(UsageRecord.model).order_by(
        func.coalesce(func.sum(UsageRecord.total_tokens), 0).desc()
    )
    rows = (await session.execute(stmt)).all()
    return [ModelUsage(model=r[0] or "", **_totals_from_row(r[1:])) for r in rows]


@router.get("/by-workspace", response_model=list[WorkspaceUsage])
async def usage_by_workspace(
    filters: dict = Depends(_filters),
    session: AsyncSession = Depends(get_session),
) -> list[WorkspaceUsage]:
    """Token/cost totals grouped by workspace (with the workspace name)."""
    stmt = _apply_filters(
        select(UsageRecord.workspace_id, Workspace.name, *_SUMS).join(
            Workspace, Workspace.id == UsageRecord.workspace_id, isouter=True
        ),
        **filters,
    )
    stmt = stmt.group_by(UsageRecord.workspace_id, Workspace.name).order_by(
        func.coalesce(func.sum(UsageRecord.total_tokens), 0).desc()
    )
    rows = (await session.execute(stmt)).all()
    return [
        WorkspaceUsage(
            workspace_id=r[0] or "",
            workspace_name=r[1] or "",
            **_totals_from_row(r[2:]),
        )
        for r in rows
    ]


@router.get("/timeseries", response_model=list[TimeseriesPoint])
async def usage_timeseries(
    filters: dict = Depends(_filters),
    session: AsyncSession = Depends(get_session),
) -> list[TimeseriesPoint]:
    """Daily token/cost totals for trend charts, oldest day first."""
    day = func.date(UsageRecord.created_at)
    stmt = _apply_filters(select(day, *_SUMS), **filters)
    stmt = stmt.group_by(day).order_by(day.asc())
    rows = (await session.execute(stmt)).all()
    return [TimeseriesPoint(date=str(r[0] or ""), **_totals_from_row(r[1:])) for r in rows]


@router.get("/file-editing", response_model=FileEditingStats)
async def file_editing_stats() -> FileEditingStats:
    """How often the hashline edit anchors go stale in this process.

    Takes no filters and touches no table: the counters live in memory and reset
    with the process (``agents/file_editing.py``). Exposed because the audit's
    remaining priority arguments all need this number and nothing else produced
    it — the logs carry the same figures per event.
    """
    stats = hashline_stats()
    return FileEditingStats(
        edits=stats.edits,
        mismatches=stats.mismatches,
        mismatch_rate=stats.mismatch_rate,
        recovered_anchors=stats.recovered_anchors,
        missing_end_hash=stats.missing_end_hash,
        blocked_writes=stats.blocked_writes,
    )
