"""Cron arithmetic, with no database and no wall clock.

Every function under test takes its reference instant as an argument, so the two
cases that actually bite — a DST transition and an app that was closed for a week
— are ordinary assertions rather than something you can only see in production.
"""

from __future__ import annotations

from datetime import UTC, datetime
from zoneinfo import ZoneInfo

import pytest

from app.cron import (
    MAX_ELAPSED_COUNT,
    CronError,
    elapsed_occurrences,
    host_timezone,
    next_fire,
    next_occurrences,
    validate_cron,
    validate_timezone,
)

NY = ZoneInfo("America/New_York")


def test_validate_cron_normalizes_whitespace():
    assert validate_cron("  30   9 * * 1-5 ") == "30 9 * * 1-5"


@pytest.mark.parametrize(
    "expr",
    [
        "",
        "* * * *",  # four fields
        "0 0 * * * *",  # six — the seconds extension croniter would accept
        "99 * * * *",  # out of range
        "not a cron",
    ],
)
def test_validate_cron_rejects_bad_expressions(expr):
    with pytest.raises(CronError):
        validate_cron(expr)


def test_validate_timezone():
    assert validate_timezone(" America/New_York ") == "America/New_York"
    with pytest.raises(CronError):
        validate_timezone("Mars/Olympus_Mons")
    with pytest.raises(CronError):
        validate_timezone("")


def test_host_timezone_is_resolvable():
    # Whatever it detects, it must be something ZoneInfo accepts — the whole point
    # is that it never hands the API an abbreviation like "EDT".
    assert validate_timezone(host_timezone()) == host_timezone()


def test_next_fire_is_strictly_after():
    at_nine = datetime(2026, 7, 28, 9, 0, tzinfo=UTC)
    # Called with the instant a fire just happened, this must roll to tomorrow —
    # the property that makes a double fire impossible.
    assert next_fire("0 9 * * *", "UTC", at_nine) == datetime(2026, 7, 29, 9, 0, tzinfo=UTC)


def test_next_fire_treats_naive_input_as_utc():
    """SQLite drops tzinfo, so a ``next_fire_at`` read back is naive."""
    aware = datetime(2026, 7, 28, 8, 0, tzinfo=UTC)
    assert next_fire("0 9 * * *", "UTC", aware) == next_fire(
        "0 9 * * *", "UTC", aware.replace(tzinfo=None)
    )


def test_nine_am_stays_nine_am_across_spring_forward():
    """2026-03-08: America/New_York loses an hour at 2am (EST -05 → EDT -04).

    A naive or UTC-only schedule would keep firing at 14:00 UTC and so drift to
    10am local. "Every day at 9am" has to mean 9am.
    """
    after = datetime(2026, 3, 6, 20, 0, tzinfo=UTC)
    occurrences = next_occurrences("0 9 * * *", "America/New_York", after=after, count=4)
    local = [o.astimezone(NY) for o in occurrences]
    assert [o.hour for o in local] == [9, 9, 9, 9]
    # Before the transition the same wall clock is a different instant than after.
    assert local[0].utcoffset().total_seconds() == -5 * 3600  # Mar 7, EST
    assert local[-1].utcoffset().total_seconds() == -4 * 3600  # Mar 10, EDT


def test_nine_am_stays_nine_am_across_fall_back():
    """2026-11-01: the same in reverse (EDT -04 → EST -05)."""
    after = datetime(2026, 10, 30, 20, 0, tzinfo=UTC)
    occurrences = next_occurrences("0 9 * * *", "America/New_York", after=after, count=4)
    local = [o.astimezone(NY) for o in occurrences]
    assert [o.hour for o in local] == [9, 9, 9, 9]
    assert local[0].utcoffset().total_seconds() == -4 * 3600  # Oct 31, EDT
    assert local[-1].utcoffset().total_seconds() == -5 * 3600  # Nov 2, EST


def test_next_occurrences_are_ascending_and_utc():
    after = datetime(2026, 7, 28, 12, 0, tzinfo=UTC)
    occurrences = next_occurrences("*/15 * * * *", "UTC", after=after, count=5)
    assert len(occurrences) == 5
    assert all(o.tzinfo is not None for o in occurrences)
    assert occurrences == sorted(occurrences)
    assert occurrences[0] == datetime(2026, 7, 28, 12, 15, tzinfo=UTC)


def test_elapsed_occurrences_counts_a_closed_weekend():
    """The startup pass's question: how many fires did a shut laptop swallow?"""
    friday_evening = datetime(2026, 7, 24, 22, 0, tzinfo=UTC)
    monday_morning = datetime(2026, 7, 27, 15, 0, tzinfo=UTC)
    # 9am Sat, Sun, Mon.
    assert (
        elapsed_occurrences(
            "0 9 * * *", "UTC", since=friday_evening, until=monday_morning
        )
        == 3
    )


def test_elapsed_occurrences_is_empty_for_a_future_window():
    now = datetime(2026, 7, 28, 12, 0, tzinfo=UTC)
    assert elapsed_occurrences("0 9 * * *", "UTC", since=now, until=now) == 0
    assert (
        elapsed_occurrences(
            "0 9 * * *", "UTC", since=now, until=now.replace(hour=11)
        )
        == 0
    )


def test_elapsed_occurrences_is_capped():
    """A schedule left enabled for a year at ``* * * * *`` must not spin here."""
    since = datetime(2025, 7, 28, tzinfo=UTC)
    until = datetime(2026, 7, 28, tzinfo=UTC)
    assert elapsed_occurrences("* * * * *", "UTC", since=since, until=until) == (
        MAX_ELAPSED_COUNT
    )
    assert (
        elapsed_occurrences("* * * * *", "UTC", since=since, until=until, cap=7) == 7
    )
