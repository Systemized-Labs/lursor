"""Cron arithmetic for scheduled jobs (see ``agents/scheduler.py``).

Pure functions over ``croniter`` + ``zoneinfo``: no database, no I/O, and no clock
of their own — every entry point takes the reference instant as an argument. That
is what makes the scheduler's decisions reproducible in a test, including the two
cases a wall-clock-reading helper can't cover: a DST transition and an app that
was closed for a week.

Everything crossing this module's boundary is an **aware UTC** ``datetime``. The
local zone exists only inside the arithmetic, because that is the only place it
means anything: "every day at 9am" is a statement about a zone's wall clock, and
resolving it to an instant is exactly the conversion these functions do.
"""

from __future__ import annotations

import contextlib
import os
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import CroniterBadCronError, croniter

# Standard cron: minute hour day-of-month month day-of-week. Six fields (the
# seconds extension croniter also accepts) is deliberately rejected — the tick is
# 30s, so sub-minute precision would be a promise this scheduler can't keep.
CRON_FIELD_COUNT = 5

# Ceiling on how many elapsed occurrences the startup pass counts. A schedule left
# enabled for a year at ``* * * * *`` has half a million of them, and the exact
# number is worthless past "a lot" — the count exists to tell the user roughly what
# they slept through, not to be summed.
MAX_ELAPSED_COUNT = 100


class CronError(ValueError):
    """A cron expression or timezone the user needs to fix.

    Distinct from a bare ``ValueError`` so callers can map it to a 422 with the
    message shown as-is, rather than guessing which failures are the user's fault.
    """


def validate_cron(expr: str) -> str:
    """Return ``expr`` stripped and normalized, or raise :class:`CronError`.

    Normalizing whitespace matters more than it looks: the stored string is what
    every later ``next_fire`` re-parses, so accepting ``"0  9 * * *"`` and storing
    it verbatim would keep re-splitting into a 5-field expression by luck.
    """
    fields = (expr or "").split()
    if len(fields) != CRON_FIELD_COUNT:
        raise CronError(
            f"Expected {CRON_FIELD_COUNT} space-separated fields "
            "(minute hour day-of-month month day-of-week), "
            f"got {len(fields)}. Example: '30 9 * * 1-5' for 9:30am on weekdays."
        )
    normalized = " ".join(fields)
    try:
        # ``is_valid`` swallows the reason, so parse for real and report it.
        croniter(normalized)
    except (CroniterBadCronError, ValueError) as exc:
        raise CronError(f"Not a valid cron expression: {exc}") from exc
    return normalized


def validate_timezone(name: str) -> str:
    """Return ``name`` if ``zoneinfo`` resolves it, else raise :class:`CronError`."""
    candidate = (name or "").strip()
    if not candidate:
        raise CronError("A timezone is required (an IANA name like 'America/New_York').")
    try:
        ZoneInfo(candidate)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise CronError(
            f"Unknown timezone {candidate!r}. Use an IANA name like 'America/New_York'."
        ) from exc
    return candidate


def host_timezone() -> str:
    """The host's IANA zone name, for defaulting a new schedule's timezone.

    There is no stdlib call for this. ``datetime.now().astimezone().tzinfo`` yields
    an *abbreviation* (``EDT``), which ``ZoneInfo`` rejects and which is ambiguous
    anyway, so resolve the real name from the two places that carry one: the ``TZ``
    environment variable, then the ``/etc/localtime`` symlink every Unix points at
    ``.../zoneinfo/<Area>/<City>``.

    Falls back to ``"UTC"`` rather than raising — a wrong *default* is recoverable
    (the form shows it and the user can change it), a failed create is not. Getting
    it right still matters: a schedule silently defaulted to UTC fires at the wrong
    hour for most of the world, and off by one more across DST.
    """
    candidates: list[str] = []
    env_tz = os.environ.get("TZ", "").strip()
    if env_tz:
        candidates.append(env_tz)
    with contextlib.suppress(OSError):
        parts = Path("/etc/localtime").resolve().parts
        if "zoneinfo" in parts:
            candidates.append("/".join(parts[parts.index("zoneinfo") + 1 :]))
    for candidate in candidates:
        with contextlib.suppress(CronError):
            return validate_timezone(candidate)
    return "UTC"


def _local(moment: datetime, timezone: str) -> datetime:
    """``moment`` as an aware datetime in ``timezone``, assuming naive means UTC.

    SQLite drops tzinfo, so a ``next_fire_at`` read back from the database is
    naive even though it was written as UTC (the same assumption
    ``schemas/_types.UTCDatetime`` makes on the way out).
    """
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=UTC)
    return moment.astimezone(ZoneInfo(timezone))


def next_fire(cron: str, timezone: str, after: datetime) -> datetime:
    """The first occurrence of ``cron`` strictly after ``after``, in UTC.

    Strictly after, so calling this with the instant a fire just happened rolls
    forward to the *next* slot instead of returning the same one — the property the
    tick relies on to be unable to double-fire.
    """
    itr = croniter(validate_cron(cron), _local(after, validate_timezone(timezone)))
    return itr.get_next(datetime).astimezone(UTC)


def next_occurrences(cron: str, timezone: str, *, after: datetime, count: int) -> list[datetime]:
    """The next ``count`` occurrences after ``after``, in UTC, ascending.

    Powers the form's live "next 5 fires" preview. A cron expression is unreadable
    and this is the cheapest way to make one trustworthy before it costs money.
    """
    itr = croniter(validate_cron(cron), _local(after, validate_timezone(timezone)))
    return [itr.get_next(datetime).astimezone(UTC) for _ in range(max(0, count))]


def elapsed_occurrences(
    cron: str,
    timezone: str,
    *,
    since: datetime,
    until: datetime,
    cap: int = MAX_ELAPSED_COUNT,
) -> int:
    """How many occurrences fell in ``(since, until]`` — capped at ``cap``.

    Used by the startup pass to say "you missed 14 fires" for a schedule whose
    ``next_fire_at`` is in the past. Counting stops at ``cap`` so a schedule that
    has been enabled and unrun for a year can't spin here.
    """
    if until <= since:
        return 0
    itr = croniter(validate_cron(cron), _local(since, validate_timezone(timezone)))
    count = 0
    while count < cap:
        occurrence = itr.get_next(datetime).astimezone(UTC)
        if occurrence > _local(until, timezone).astimezone(UTC):
            break
        count += 1
    return count
