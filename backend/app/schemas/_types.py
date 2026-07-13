"""Shared annotated field types for schemas."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from pydantic import PlainSerializer


def _serialize_utc(value: datetime) -> str:
    """Serialize a datetime as an ISO-8601 string with an explicit offset.

    SQLite drops timezone info, so datetimes read back from the DB are naive
    even though they were written as UTC. Emitting them without an offset
    makes clients (e.g. JS ``new Date(...)``) parse them as local time, which
    can land the instant in the future. Assume naive datetimes are UTC and
    always include the offset so timestamps are unambiguous.
    """
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value.isoformat()


UTCDatetime = Annotated[datetime, PlainSerializer(_serialize_utc, return_type=str)]
"""A ``datetime`` that always serializes with an explicit UTC offset."""
