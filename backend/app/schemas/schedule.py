from __future__ import annotations

from pydantic import BaseModel, field_validator

from app.cron import CronError, validate_cron, validate_timezone
from app.db.models import ScheduleFireStatus, ScheduleRunType
from app.schemas._types import UTCDatetime

# The lowest cap worth allowing on a goal schedule, and the highest. Below 1 a goal
# fire could never evaluate; the ceiling exists because ``max_iterations`` is the
# only bound on an unattended goal run's spend.
MIN_ITERATIONS = 1
MAX_ITERATIONS = 200


def _cron(value: str) -> str:
    """Validate through :mod:`app.cron`, re-raising as a pydantic error.

    Converting :class:`CronError` to ``ValueError`` here is what turns a bad
    expression into a 422 carrying the reason, instead of a 500 the browser reports
    as "Failed to fetch".
    """
    try:
        return validate_cron(value)
    except CronError as exc:
        raise ValueError(str(exc)) from exc


def _timezone(value: str) -> str:
    try:
        return validate_timezone(value)
    except CronError as exc:
        raise ValueError(str(exc)) from exc


def _prompt(value: str) -> str:
    text = (value or "").strip()
    if not text:
        raise ValueError("A prompt is required — it is the turn each fire sends.")
    return text


class ScheduleCreate(BaseModel):
    name: str = "New schedule"
    description: str = ""
    enabled: bool = True
    workspace_id: str
    agent_id: str
    cron: str
    timezone: str
    prompt: str
    run_type: ScheduleRunType = ScheduleRunType.chat
    success_criteria: str = ""
    max_iterations: int = 25

    @field_validator("cron")
    @classmethod
    def _check_cron(cls, value: str) -> str:
        return _cron(value)

    @field_validator("timezone")
    @classmethod
    def _check_timezone(cls, value: str) -> str:
        return _timezone(value)

    @field_validator("prompt")
    @classmethod
    def _check_prompt(cls, value: str) -> str:
        return _prompt(value)

    @field_validator("max_iterations")
    @classmethod
    def _check_iterations(cls, value: int) -> int:
        if not MIN_ITERATIONS <= value <= MAX_ITERATIONS:
            raise ValueError(f"Must be between {MIN_ITERATIONS} and {MAX_ITERATIONS}.")
        return value


class ScheduleUpdate(BaseModel):
    """Partial update. Omitted fields are left alone.

    ``next_fire_at`` / ``last_fired_at`` are scheduler bookkeeping and are
    deliberately not settable — the router recomputes the former whenever ``cron``,
    ``timezone`` or ``enabled`` changes.
    """

    name: str | None = None
    description: str | None = None
    enabled: bool | None = None
    workspace_id: str | None = None
    agent_id: str | None = None
    cron: str | None = None
    timezone: str | None = None
    prompt: str | None = None
    run_type: ScheduleRunType | None = None
    success_criteria: str | None = None
    max_iterations: int | None = None

    @field_validator("cron")
    @classmethod
    def _check_cron(cls, value: str | None) -> str | None:
        return None if value is None else _cron(value)

    @field_validator("timezone")
    @classmethod
    def _check_timezone(cls, value: str | None) -> str | None:
        return None if value is None else _timezone(value)

    @field_validator("prompt")
    @classmethod
    def _check_prompt(cls, value: str | None) -> str | None:
        return None if value is None else _prompt(value)

    @field_validator("max_iterations")
    @classmethod
    def _check_iterations(cls, value: int | None) -> int | None:
        if value is None:
            return None
        if not MIN_ITERATIONS <= value <= MAX_ITERATIONS:
            raise ValueError(f"Must be between {MIN_ITERATIONS} and {MAX_ITERATIONS}.")
        return value


class ScheduleRunRead(BaseModel):
    """One attempted fire, including the ones that did not run."""

    id: str
    schedule_id: str
    thread_id: str | None = None
    fired_at: UTCDatetime
    status: ScheduleFireStatus
    missed_count: int = 0
    detail: str = ""

    model_config = {"from_attributes": True}


class ScheduleRead(BaseModel):
    id: str
    name: str
    description: str
    enabled: bool
    workspace_id: str
    agent_id: str
    cron: str
    timezone: str
    prompt: str
    run_type: ScheduleRunType
    success_criteria: str
    max_iterations: int
    next_fire_at: UTCDatetime | None = None
    last_fired_at: UTCDatetime | None = None
    # The most recent attempted fire, so the rail can flag a schedule whose last
    # outcome was missed / skipped / error without a request per row.
    last_run: ScheduleRunRead | None = None
    created_at: UTCDatetime
    updated_at: UTCDatetime

    model_config = {"from_attributes": True}


class CronPreviewRequest(BaseModel):
    cron: str
    timezone: str
    # Enough to see the shape of a weekly or weekday pattern without a wall of
    # dates; the form renders all of them.
    count: int = 5

    @field_validator("cron")
    @classmethod
    def _check_cron(cls, value: str) -> str:
        return _cron(value)

    @field_validator("timezone")
    @classmethod
    def _check_timezone(cls, value: str) -> str:
        return _timezone(value)

    @field_validator("count")
    @classmethod
    def _check_count(cls, value: int) -> int:
        if not 1 <= value <= 20:
            raise ValueError("Must be between 1 and 20.")
        return value


class CronPreviewRead(BaseModel):
    """Upcoming fire instants for a candidate expression.

    A cron string is unreadable; this is what makes one trustworthy before it costs
    money, so the form calls it on every keystroke that parses.
    """

    cron: str
    timezone: str
    occurrences: list[UTCDatetime] = []
