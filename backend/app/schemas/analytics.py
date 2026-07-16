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
