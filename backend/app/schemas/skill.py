from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel


class SkillCreate(BaseModel):
    name: str
    description: str = ""
    content: str = ""


class SkillUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    content: str | None = None


class SkillRead(BaseModel):
    id: str
    name: str
    description: str
    content: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
