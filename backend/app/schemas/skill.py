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
    # Off keeps the skill and its files exactly as they are but excludes it from
    # every run. Toggling it never touches SKILL.md — it isn't frontmatter.
    enabled: bool | None = None


class SkillPromote(BaseModel):
    """Assignment to apply when promoting or copying a skill into the catalog.

    Both unset means "assign it to the workspace it came from", so promoting
    changes where a skill *can* go without changing where it currently applies.
    A copied ``external`` skill has no originating workspace and defaults to
    global, matching the reach it already had.
    """

    is_global: bool | None = None
    workspace_ids: list[str] | None = None


class SkillIngest(BaseModel):
    """Ingest skill folders that are already on disk inside a workspace.

    ``path`` is workspace-relative and may name a skill folder itself or a
    directory holding several. ``origin`` picks the destination: ``managed``
    copies into the catalog, ``local`` into the workspace's own
    ``.agents/skills``. ``is_global`` is for a managed ingest only, and unset
    means "assign it to the workspace it was found in" — a skill folder sitting
    in a repo is evidence about that repo, not about every workspace.
    """

    workspace_id: str
    path: str = ""
    origin: SkillOrigin = SkillOrigin.managed
    is_global: bool | None = None


class SkillScanEntry(BaseModel):
    """One skill folder found in a workspace directory, not yet ingested."""

    # Workspace-relative path of the folder (not its SKILL.md).
    path: str
    slug: str
    name: str
    description: str = ""
    # Already in the index — it sits in a discovered root (``.claude/skills``) or
    # has been ingested before. Ingesting it again would only duplicate it.
    indexed: bool = False


class SkillScanResult(BaseModel):
    skills: list[SkillScanEntry] = []


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
    # Which root the folder lives in: workspace-relative for ``local``
    # (".claude/skills"), absolute for ``external``, empty for the catalog.
    root: str = ""
    # Display form of ``root`` (".claude", "~/.claude"), computed server-side so
    # no client has to parse paths. Empty for the catalog.
    root_label: str = ""
    # Whether Lursor owns this root. False means the folder belongs to another
    # tool: it can be copied into the catalog but never moved out of, and a
    # delete removes a real file in the user's repo or home directory.
    is_owned_root: bool = True
    # Set when this catalog entry is a *symlink* into another tool's directory:
    # the absolute folder it points at. A managed skill in every other respect —
    # assignable, env vars, editable — but the files are the original, so an edit
    # here is an edit there and deleting it only removes the link.
    link_target: str = ""
    # Display form of the root ``link_target`` lives in ("~/.claude"), for a badge
    # saying whose files these really are. Empty when this is not a link.
    link_label: str = ""
    # Off excludes the skill from every run, whatever its layer or assignment.
    enabled: bool = True
    # Why this skill's SKILL.md can't be loaded ("mapping values are not allowed
    # here (line 3, column 358)"), empty when it parses. Set means the folder is
    # indexed and editable but excluded from every run whatever its assignment:
    # the agent library parses frontmatter strictly and one bad file would fail
    # the whole build. Surfaced so a skill that silently stopped applying says so.
    error: str = ""
    # Which layer this row won at, set only when listing for one workspace
    # ("user" | "global" | "workspace" | "local"). Null in catalog-wide listings.
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
