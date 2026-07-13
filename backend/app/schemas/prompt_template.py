from __future__ import annotations

from pydantic import BaseModel

from app.schemas._types import UTCDatetime


class PromptTemplateCreate(BaseModel):
    name: str
    description: str = ""
    category: str = "general"
    content: str = ""


class PromptTemplateUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    category: str | None = None
    content: str | None = None


class PromptTemplateRead(BaseModel):
    id: str
    name: str
    description: str
    category: str
    content: str
    is_builtin: bool
    created_at: UTCDatetime
    updated_at: UTCDatetime

    model_config = {"from_attributes": True}
