from __future__ import annotations

from pydantic import BaseModel

from app.schemas._types import UTCDatetime


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
    created_at: UTCDatetime
    updated_at: UTCDatetime

    model_config = {"from_attributes": True}
