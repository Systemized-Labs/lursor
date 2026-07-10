"""Render a database :class:`Agent` row into a runnable deep agent.

``create_deep_agent`` returns a plain ``pydantic_ai.Agent`` (typed over
``DeepAgentDeps``), which the AG-UI adapter can dispatch directly. The agent's
filesystem is rooted at the workspace directory via a ``LocalBackend``.
"""

from __future__ import annotations

from pathlib import Path

from pydantic_ai import Agent as PydanticAgent
from pydantic_ai_backends import LocalBackend
from pydantic_deep import DeepAgentDeps, create_deep_agent, create_default_deps
from pydantic_deep import Skill as DeepSkill

from app.config import get_settings
from app.db.models import Agent as AgentRow

settings = get_settings()


def build_deep_agent(
    row: AgentRow, workspace_path: str | Path
) -> tuple[PydanticAgent, DeepAgentDeps]:
    """Build a deep agent + deps for ``row`` scoped to ``workspace_path``.

    Skills attached to the agent are passed through as deep-agent skills. Tool
    rows are catalogued in the DB but not yet wired into execution (see
    docs/PLAN.md — deferred); the deep agent ships its own builtin toolset.
    """
    backend = LocalBackend(root_dir=str(workspace_path))

    # thinking is stored as an enum: "off" disables, otherwise pass the level string.
    thinking: bool | str = False if row.thinking.value == "off" else row.thinking.value

    skills = [
        DeepSkill(name=s.name, description=s.description, content=s.content) for s in row.skills
    ]

    agent = create_deep_agent(
        model=row.model or settings.default_model,
        instructions=row.instructions or None,
        backend=backend,
        skills=skills or None,
        include_todo=row.include_todo,
        include_subagents=row.include_subagents,
        include_skills=row.include_skills,
        include_memory=row.include_memory,
        include_plan=row.include_plan,
        web_search=row.web_search,
        thinking=thinking,
        **row.extra_config,
    )
    deps = create_default_deps(backend)
    return agent, deps
