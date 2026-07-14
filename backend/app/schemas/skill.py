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
    slug: str
    name: str
    description: str
    content: str
    # Bundled files discovered in the skill folder (relative paths). These are
    # what the agent can load via `read_skill_resource` / `run_skill_script`.
    resources: list[str] = []
    scripts: list[str] = []
    created_at: UTCDatetime
    updated_at: UTCDatetime

    model_config = {"from_attributes": True}


class SkillResourceContent(BaseModel):
    """Body for reading/writing a bundled resource or script file."""

    content: str
