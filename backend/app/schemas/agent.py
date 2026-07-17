from __future__ import annotations

from typing import Any

from pydantic import BaseModel

from app.agents.prompt_author import AgentPromptContext
from app.db.models import Agent, ThinkingLevel, ToolChoice
from app.schemas._types import UTCDatetime

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
    thinking: ThinkingLevel = ThinkingLevel.off
    tool_choice: ToolChoice = ToolChoice.auto
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
    thinking: ThinkingLevel | None = None
    tool_choice: ToolChoice | None = None
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
    thinking: ThinkingLevel
    tool_choice: ToolChoice
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
            thinking=agent.thinking,
            tool_choice=agent.tool_choice,
            extra_config=agent.extra_config,
            tool_ids=[t.id for t in agent.tools],
            created_at=agent.created_at,
            updated_at=agent.updated_at,
        )
