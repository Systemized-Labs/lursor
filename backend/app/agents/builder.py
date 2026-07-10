"""Render a database :class:`Agent` row into a runnable deep agent.

``create_deep_agent`` returns a plain ``pydantic_ai.Agent`` (typed over
``DeepAgentDeps``), which the AG-UI adapter can dispatch directly. The agent's
filesystem is rooted at the workspace directory via a ``LocalBackend``.
"""

from __future__ import annotations

from pathlib import Path

from pydantic_ai import Agent as PydanticAgent
from pydantic_ai.models import Model
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai_backends import LocalBackend
from pydantic_deep import DeepAgentDeps, create_deep_agent, create_default_deps
from pydantic_deep import Skill as DeepSkill

from app.agents.tolerant_model import TolerantOpenAIChatModel
from app.config import get_settings
from app.db.models import Agent as AgentRow
from app.db.models import CustomProvider

settings = get_settings()

# Prefix on a stored model string that marks a locally-hosted custom provider.
# Format: "custom:{provider_id}:{model_name}" (model_name may itself contain
# colons, e.g. Ollama's "llama3:8b", so we only split on the first colon).
CUSTOM_PREFIX = "custom:"


def resolve_model(
    model_str: str, providers: dict[str, CustomProvider]
) -> str | Model:
    """Turn a stored model string into a value ``create_deep_agent`` accepts.

    Cloud (``openrouter:``) strings are passed through untouched. A ``custom:``
    string is resolved against ``providers`` (keyed by id) into an
    OpenAI-compatible model object pointed at that provider's base URL. An
    unknown provider falls back to the default model.
    """
    if not model_str.startswith(CUSTOM_PREFIX):
        return model_str

    provider_id, _, model_name = model_str[len(CUSTOM_PREFIX) :].partition(":")
    provider = providers.get(provider_id)
    if provider is None or not model_name:
        return settings.default_model

    # Route through the tolerant model: local OpenAI-compatible servers
    # (vLLM/llama.cpp/LM Studio, often behind a LiteLLM proxy) run strict chat
    # templates that reject request shapes cloud providers accept. It normalizes
    # the outgoing messages (merges the leading system-message run, coerces
    # tool-call arguments to JSON, guarantees a user turn).
    model = TolerantOpenAIChatModel(
        model_name,
        provider=OpenAIProvider(
            base_url=provider.base_url,
            # Local servers usually need no key; OpenAIProvider requires a
            # non-null value, so send a placeholder when none is configured.
            api_key=provider.api_key or "api-key-not-set",
        ),
    )
    # Strict local templates reject a request with no user turn; guarantee one.
    model._ensure_user_message = True
    return model


def build_deep_agent(
    row: AgentRow,
    workspace_path: str | Path,
    custom_providers: dict[str, CustomProvider] | None = None,
) -> tuple[PydanticAgent, DeepAgentDeps]:
    """Build a deep agent + deps for ``row`` scoped to ``workspace_path``.

    Skills attached to the agent are passed through as deep-agent skills. Tool
    rows are catalogued in the DB but not yet wired into execution (see
    docs/PLAN.md — deferred); the deep agent ships its own builtin toolset.

    ``custom_providers`` maps provider id → row and is used to route runs that
    target a locally-hosted model; callers that never use custom models can omit
    it.
    """
    backend = LocalBackend(root_dir=str(workspace_path))

    # thinking is stored as an enum: "off" disables, otherwise pass the level string.
    thinking: bool | str = False if row.thinking.value == "off" else row.thinking.value

    skills = [
        DeepSkill(name=s.name, description=s.description, content=s.content) for s in row.skills
    ]

    agent = create_deep_agent(
        model=resolve_model(row.model or settings.default_model, custom_providers or {}),
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
