from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

from app.schemas._types import UTCDatetime


class ProviderCreate(BaseModel):
    name: str
    base_url: str
    api_key: str | None = None


class ProviderHealth(BaseModel):
    """Result of probing a provider's OpenAI-compatible ``/models`` endpoint."""

    status: Literal["ok", "error"]
    model_count: int | None = None  # models advertised when reachable
    error: str | None = None  # human-readable reason when status is "error"


class ProviderUpdate(BaseModel):
    name: str | None = None
    base_url: str | None = None
    api_key: str | None = None


class ProviderRead(BaseModel):
    id: str
    name: str
    base_url: str
    api_key: str | None
    created_at: UTCDatetime
    updated_at: UTCDatetime

    model_config = {"from_attributes": True}
