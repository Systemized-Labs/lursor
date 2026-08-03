from __future__ import annotations

from pydantic import BaseModel


class UsageTotals(BaseModel):
    """Aggregated token counts + cost for a slice of usage records."""

    records: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    requests: int = 0
    cost_usd: float = 0.0


class ModelUsage(UsageTotals):
    model: str


class WorkspaceUsage(UsageTotals):
    workspace_id: str
    workspace_name: str = ""


class TimeseriesPoint(UsageTotals):
    # ISO date (YYYY-MM-DD) bucket.
    date: str


class FileEditingStats(BaseModel):
    """Counters from ``agents/file_editing.py``, since this process started.

    Process-wide and not persisted: the question they answer is "how often do the
    hashline anchors actually go stale", which is a property of the edit format and
    the models we run, not of any one workspace. See ``docs/FILE-EDITING-AUDIT.md``
    — under ~1% and the remaining hash findings are noise; 10%+ and the format is
    costing more than it saves.
    """

    edits: int = 0
    mismatches: int = 0
    mismatch_rate: float = 0.0
    recovered_anchors: int = 0
    missing_end_hash: int = 0
    blocked_writes: int = 0
