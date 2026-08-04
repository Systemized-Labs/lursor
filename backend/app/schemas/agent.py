from __future__ import annotations

from typing import Annotated, Any

from pydantic import BaseModel, Field

from app.agents.prompt_author import AgentPromptContext
from app.db.models import Agent, ThinkingLevel, ToolChoice
from app.schemas._types import UTCDatetime

# Compaction overrides are fractions of the model's context window, so both are
# constrained to (0, 1]. ``None`` clears the override and reverts the agent to the
# app-wide default (see ``agents/context_budget.py``).
CompactionFraction = Annotated[float | None, Field(gt=0, le=1)]

__all__ = [
    "AgentCreate",
    "AgentUpdate",
    "AgentRead",
    "AgentPromptContext",
    "PromptGenerateRequest",
    "PromptImproveRequest",
    "PromptResult",
]


class AgentCreate(BaseModel):
    name: str
    description: str = ""
    model: str | None = None
    instructions: str = ""
    include_todo: bool = True
    include_subagents: bool = False
    include_skills: bool = True
    include_memory: bool = False
    include_plan: bool = False
    web_search: bool = False
    browser_qa: bool = True
    include_video: bool = False
    thinking: ThinkingLevel = ThinkingLevel.off
    tool_choice: ToolChoice = ToolChoice.auto
    compaction_threshold: CompactionFraction = None
    compaction_ratio: CompactionFraction = None
    extra_config: dict[str, Any] = {}
    tool_ids: list[str] = []


class AgentUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    model: str | None = None
    instructions: str | None = None
    include_todo: bool | None = None
    include_subagents: bool | None = None
    include_skills: bool | None = None
    include_memory: bool | None = None
    include_plan: bool | None = None
    web_search: bool | None = None
    browser_qa: bool | None = None
    include_video: bool | None = None
    thinking: ThinkingLevel | None = None
    tool_choice: ToolChoice | None = None
    # Unlike the other fields here, ``None`` is a meaningful *value* rather than
    # "leave alone": the route applies only what the request actually sent
    # (``exclude_unset``), so sending null clears the override.
    compaction_threshold: CompactionFraction = None
    compaction_ratio: CompactionFraction = None
    extra_config: dict[str, Any] | None = None
    tool_ids: list[str] | None = None


class PromptGenerateRequest(BaseModel):
    brief: str
    context: AgentPromptContext = AgentPromptContext()


class PromptImproveRequest(BaseModel):
    current: str
    context: AgentPromptContext = AgentPromptContext()


class PromptResult(BaseModel):
    instructions: str


class AgentRead(BaseModel):
    id: str
    name: str
    description: str
    model: str | None
    instructions: str
    include_todo: bool
    include_subagents: bool
    include_skills: bool
    include_memory: bool
    include_plan: bool
    web_search: bool
    browser_qa: bool
    include_video: bool
    thinking: ThinkingLevel
    tool_choice: ToolChoice
    compaction_threshold: float | None
    compaction_ratio: float | None
    extra_config: dict[str, Any]
    tool_ids: list[str]
    created_at: UTCDatetime
    updated_at: UTCDatetime

    @classmethod
    def from_agent(cls, agent: Agent) -> AgentRead:
        return cls(
            id=agent.id,
            name=agent.name,
            description=agent.description,
            model=agent.model,
            instructions=agent.instructions,
            include_todo=agent.include_todo,
            include_subagents=agent.include_subagents,
            include_skills=agent.include_skills,
            include_memory=agent.include_memory,
            include_plan=agent.include_plan,
            web_search=agent.web_search,
            browser_qa=agent.browser_qa,
            include_video=agent.include_video,
            thinking=agent.thinking,
            tool_choice=agent.tool_choice,
            compaction_threshold=agent.compaction_threshold,
            compaction_ratio=agent.compaction_ratio,
            extra_config=agent.extra_config,
            tool_ids=[t.id for t in agent.tools],
            created_at=agent.created_at,
            updated_at=agent.updated_at,
        )
