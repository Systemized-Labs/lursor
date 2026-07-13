"""Schemas for laios control-plane connections.

A connection points Lursor at a laios daemon (``:7420``). The ``master_key`` is
write-only from the client's perspective: it is accepted on create/update but
never echoed back — reads expose only ``has_master_key`` so the UI can show
whether one is configured without leaking the secret to the browser.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

from app.schemas._types import UTCDatetime


class LaiosConnectionCreate(BaseModel):
    name: str
    base_url: str
    master_key: str | None = None


class LaiosConnectionUpdate(BaseModel):
    name: str | None = None
    base_url: str | None = None
    master_key: str | None = None


class LaiosConnectionRead(BaseModel):
    id: str
    name: str
    base_url: str
    has_master_key: bool
    created_at: UTCDatetime
    updated_at: UTCDatetime


class LaiosConnectionStatus(BaseModel):
    """Result of probing a daemon's ``/health`` (+ ``/v1/route``)."""

    status: Literal["ok", "error"]
    reachable: bool = False
    role: str | None = None  # "head" | "worker"
    node_id: str | None = None
    version: str | None = None
    master_key_set: bool | None = None  # from /v1/route; None if unauthorized
    error: str | None = None  # human-readable reason when status is "error"
