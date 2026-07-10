from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel

from app.db.models import ToolKind


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
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
