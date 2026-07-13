from __future__ import annotations

from typing import Any

from pydantic import BaseModel

from app.db.models import ToolKind
from app.schemas._types import UTCDatetime


class ToolCreate(BaseModel):
    name: str
    description: str = ""
    kind: ToolKind = ToolKind.builtin
    config: dict[str, Any] = {}


class ToolUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    kind: ToolKind | None = None
    config: dict[str, Any] | None = None


class ToolRead(BaseModel):
    id: str
    name: str
    description: str
    kind: ToolKind
    config: dict[str, Any]
    created_at: UTCDatetime
    updated_at: UTCDatetime

    model_config = {"from_attributes": True}
