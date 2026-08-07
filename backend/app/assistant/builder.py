"""Build the Assistant — the one call that attaches the control plane.

This is the whole divergence from an ordinary run. ``api/chat.py`` branches here
once, in ``_build_agent_and_context``, and everything downstream — persistence,
SSE fan-out, ``/stop``, reconnect, compaction, usage accounting, auto-titling —
is the same code every other agent goes through. Duplicating that machinery to
give the Assistant its own endpoint would have been ~500 lines of drift waiting
to happen.

What is different, and only this:

- the model comes from ``AppConfig.assistant_model`` (falling back to
  :data:`~app.assistant.identity.DEFAULT_ASSISTANT_MODEL`) rather than the agent
  row, which is deliberately null;
- the system prompt is :data:`~app.assistant.prompt.ASSISTANT_PROMPT`, a code
  constant, rather than ``row.instructions``, which is deliberately empty;
- ``extra_tools`` carries the control plane, which is also what marks the build
  as entitled to hold it (see ``agents/builder.build_deep_agent``).
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.agents.builder import build_deep_agent
from app.agents.hindsight import resolve_hindsight_config
from app.agents.skill_runtime import load_skill_runtime
from app.assistant.identity import DEFAULT_ASSISTANT_MODEL
from app.assistant.prompt import ASSISTANT_PROMPT
from app.config import get_settings
from app.db.models import Agent, AppConfig, CustomProvider, Subagent, Workspace

settings = get_settings()


def resolve_assistant_model(app_config: AppConfig | None) -> str:
    """Which model the Assistant runs on.

    One source of truth, checked in one place: the saved setting, else the
    shipped default. The agent row's own ``model`` column stays null on purpose —
    two places to set the same thing is two places for it to drift.
    """
    saved = (getattr(app_config, "assistant_model", None) or "").strip()
    return saved or DEFAULT_ASSISTANT_MODEL


async def build_assistant_context(
    session: AsyncSession,
    agent_row: Agent,
    workspace: Workspace,
    *,
    thread_id: str,
    read_only: bool = False,
):
    """The same 5-tuple ``_build_agent_and_context`` returns, control plane attached.

    ``read_only`` (an ``/ask`` turn) is threaded through unchanged. It composes:
    the read-only allowlist names no ``lursor_*`` tool, so an ``/ask`` turn to the
    Assistant keeps its ordinary read tools and loses the whole control plane —
    which is the right reading of "ask, don't act".
    """
    # Imported here, not at module scope, to break a genuine cycle: ``api/chat.py``
    # imports this module, and ``tools`` imports ``api/chat`` for ``lursor_delegate``.
    # At module scope it happens to work when ``api.chat`` is the import root and
    # fails when anything else is — which is the worst kind of working.
    from app.assistant.tools import build_assistant_tools

    providers = (await session.execute(select(CustomProvider))).scalars().all()
    custom_providers = {p.id: p for p in providers}
    subagents = list((await session.execute(select(Subagent))).scalars().all())
    app_config = (await session.execute(select(AppConfig))).scalars().first()

    skill_runtime = await load_skill_runtime(
        session,
        workspace_path=workspace.path,
        workspace_id=workspace.id,
        include_skills=agent_row.include_skills,
    )

    agent, deps = build_deep_agent(
        agent_row,
        workspace.path,
        custom_providers,
        subagents,
        app_config.deep_defaults if app_config else None,
        workspace_name=workspace.name,
        workspace_description=workspace.description or None,
        workspace_id=workspace.id,
        skill_runtime=skill_runtime,
        # No video or image runtime: generating media is not control-plane work,
        # and resolving either costs a round trip to a laios box per turn.
        video_runtime=None,
        image_runtime=None,
        read_only=read_only,
        plan_mode=False,
        model_override=resolve_assistant_model(app_config),
        web_search_provider=app_config.web_search_provider if app_config else None,
        tavily_api_key=(app_config.tavily_api_key if app_config else None)
        or settings.tavily_api_key,
        exa_api_key=(app_config.exa_api_key if app_config else None) or settings.exa_api_key,
        hindsight=resolve_hindsight_config(app_config, settings),
        compaction_model=app_config.compaction_model if app_config else None,
        extra_tools=build_assistant_tools(thread_id),
        instructions_override=ASSISTANT_PROMPT,
    )
    return agent, deps, custom_providers, app_config, skill_runtime
