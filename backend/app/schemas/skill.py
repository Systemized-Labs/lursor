from __future__ import annotations

from pydantic import BaseModel

from app.db.models import SkillOrigin
from app.schemas._types import UTCDatetime


class SkillAssignment(BaseModel):
    """Where a managed skill applies.

    ``is_global`` wins: setting it clears ``workspace_ids`` server-side, since
    global already covers every workspace. Neither set means "in the catalog,
    injected nowhere" — the parked state.
    """

    is_global: bool = False
    workspace_ids: list[str] = []


class SkillCreate(BaseModel):
    name: str
    description: str = ""
    content: str = ""
    # ``managed`` lands in the catalog (``~/.lursor/skills``) and carries an
    # assignment; ``local`` is written into ``<workspace>/.agents/skills`` and
    # requires ``workspace_id``.
    origin: SkillOrigin = SkillOrigin.managed
    # Assignment for a managed skill. ``is_global`` unset means "global unless
    # workspaces were named", so the common case (create a skill, use it
    # everywhere) needs no extra field.
    is_global: bool | None = None
    workspace_ids: list[str] = []
    # Owning workspace for a local skill.
    workspace_id: str | None = None


class SkillUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    content: str | None = None


class SkillPromote(BaseModel):
    """Assignment to apply when promoting a local skill into the catalog.

    Both unset means "assign it to the workspace it came from", so promoting
    changes where a skill *can* go without changing where it currently applies.
    """

    is_global: bool | None = None
    workspace_ids: list[str] | None = None


class SkillRead(BaseModel):
    id: str
    slug: str
    name: str
    description: str
    content: str
    origin: SkillOrigin
    # Managed skills: the assignment. ``workspace_ids`` is empty for a global or
    # parked skill.
    is_global: bool = False
    workspace_ids: list[str] = []
    # Local skills: the workspace whose folder holds it.
    workspace_id: str | None = None
    # Which layer this row won at, set only when listing for one workspace
    # ("global" | "workspace" | "local"). Null in catalog-wide listings.
    layer: str | None = None
    # Env vars attached to this skill (ids only; values never leave the server).
    env_var_ids: list[str] = []
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
