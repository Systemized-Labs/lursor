from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class ProviderCreate(BaseModel):
    name: str
    base_url: str
    api_key: str | None = None


class ProviderUpdate(BaseModel):
    name: str | None = None
    base_url: str | None = None
    api_key: str | None = None


class ProviderRead(BaseModel):
    id: str
    name: str
    base_url: str
    api_key: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
