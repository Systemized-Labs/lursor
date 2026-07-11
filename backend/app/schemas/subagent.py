from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class SubagentCreate(BaseModel):
    name: str
    description: str = ""
    instructions: str = ""
    model: str | None = None


class SubagentUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    instructions: str | None = None
    model: str | None = None


class SubagentRead(BaseModel):
    id: str
    name: str
    description: str
    instructions: str
    model: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
