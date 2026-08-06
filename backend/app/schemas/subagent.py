from __future__ import annotations

from typing import Any

from pydantic import BaseModel

from app.db.models import Subagent, ThinkingLevel, ToolChoice
from app.schemas._types import UTCDatetime
from app.schemas.agent import CompactionFraction


class SubagentCreate(BaseModel):
    name: str
    description: str = ""
    instructions: str = ""
    model: str | None = None
    include_todo: bool = True
    include_subagents: bool = False
    include_skills: bool = True
    include_memory: bool = False
    include_plan: bool = False
    web_search: bool = False
    include_video: bool = False
    include_image: bool = False
    thinking: ThinkingLevel = ThinkingLevel.off
    tool_choice: ToolChoice = ToolChoice.auto
    compaction_threshold: CompactionFraction = None
    compaction_ratio: CompactionFraction = None
    enabled: bool = True
    extra_config: dict[str, Any] = {}
    tool_ids: list[str] = []


class SubagentUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    instructions: str | None = None
    model: str | None = None
    include_todo: bool | None = None
    include_subagents: bool | None = None
    include_skills: bool | None = None
    include_memory: bool | None = None
    include_plan: bool | None = None
    web_search: bool | None = None
    include_video: bool | None = None
    include_image: bool | None = None
    thinking: ThinkingLevel | None = None
    tool_choice: ToolChoice | None = None
    # Null clears the override (see ``AgentUpdate``), not "leave alone".
    compaction_threshold: CompactionFraction = None
    compaction_ratio: CompactionFraction = None
    enabled: bool | None = None
    extra_config: dict[str, Any] | None = None
    tool_ids: list[str] | None = None


class SubagentRead(BaseModel):
    id: str
    name: str
    description: str
    instructions: str
    model: str | None
    include_todo: bool
    include_subagents: bool
    include_skills: bool
    include_memory: bool
    include_plan: bool
    web_search: bool
    include_video: bool
    include_image: bool
    thinking: ThinkingLevel
    tool_choice: ToolChoice
    compaction_threshold: float | None
    compaction_ratio: float | None
    enabled: bool
    extra_config: dict[str, Any]
    tool_ids: list[str]
    created_at: UTCDatetime
    updated_at: UTCDatetime

    @classmethod
    def from_subagent(cls, sa: Subagent) -> SubagentRead:
        return cls(
            id=sa.id,
            name=sa.name,
            description=sa.description,
            instructions=sa.instructions,
            model=sa.model,
            include_todo=sa.include_todo,
            include_subagents=sa.include_subagents,
            include_skills=sa.include_skills,
            include_memory=sa.include_memory,
            include_plan=sa.include_plan,
            web_search=sa.web_search,
            include_video=sa.include_video,
            include_image=sa.include_image,
            thinking=sa.thinking,
            tool_choice=sa.tool_choice,
            compaction_threshold=sa.compaction_threshold,
            compaction_ratio=sa.compaction_ratio,
            enabled=sa.enabled,
            extra_config=sa.extra_config,
            tool_ids=[t.id for t in sa.tools],
            created_at=sa.created_at,
            updated_at=sa.updated_at,
        )


# --- Subagent defaults (pydantic-deep built-ins + governing knobs) -------------


class ResolvedInt(BaseModel):
    """A single integer knob: what the library ships vs. the effective value."""

    library_default: int
    override: int | None
    effective: int


class BuiltinSubagentRead(BaseModel):
    """A pydantic-deep built-in subagent: its library default + current state.

    Read-only apart from ``enabled``. The UI shows the library text and offers to
    seed a new user subagent from it; there is no editable copy of a built-in.
    """

    name: str
    # Library defaults (read-only reference the UI shows and seeds a copy from).
    default_description: str
    default_instructions: str
    # True unless the user disabled it.
    enabled: bool


class SubagentDefaultsRead(BaseModel):
    max_nesting_depth: ResolvedInt
    builtins: list[BuiltinSubagentRead]


class SubagentDefaultsUpdate(BaseModel):
    """Partial update of the global subagent defaults.

    ``max_nesting_depth=None`` clears the override (revert to the library
    default). ``disabled_builtins`` replaces the disabled set wholesale.
    """

    max_nesting_depth: int | None = None
    clear_max_nesting_depth: bool = False
    disabled_builtins: list[str] | None = None
