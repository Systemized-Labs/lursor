"""The Assistant's workspace, and the agent that starts out in it.

Privilege attaches to the **workspace**, not to an agent. Any agent you select in
the Assistant workspace gets the control-plane toolset for that run; the same
agent used in one of your projects does not. That is the whole recognition rule,
and :func:`is_assistant_workspace` is the whole of its implementation.

The workspace is app-owned in the same way the Skill Studio is: a real row at a
known location, a *computed* flag on the read model, and a sidebar that files it
separately from your projects. It cannot be moved or deleted, because the runs
that happen there are the ones holding the control plane.

The agent seeded alongside it is **ordinary**. It exists so a fresh install has
something to talk to, on a sensible model. Rename it, retarget it, rewrite its
prompt, delete it and use your own — none of that changes what it can do, because
none of that is where the privilege lives.
"""

from __future__ import annotations

from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.config import get_settings
from app.db.models import Agent, ThinkingLevel, ToolChoice, Workspace

settings = get_settings()

# Stable primary keys. Deliberately not uuids: the workspace id is compared on
# every turn, and a literal makes the seeded rows obvious in a ``sqlite3``
# session. The agent id is only a seed key — it grants nothing.
ASSISTANT_WORKSPACE_ID = "lursor-assistant-ws"
ASSISTANT_AGENT_ID = "lursor-assistant"

ASSISTANT_AGENT_NAME = "Assistant"
ASSISTANT_WORKSPACE_NAME = "Assistant"
ASSISTANT_WORKSPACE_DESCRIPTION = (
    "Drive Lursor itself from here. Agents used in this workspace can create "
    "workspaces, retarget other agents, manage schedules and read the bill."
)

# What the seeded agent ships pointed at: GLM 5.2 through OpenRouter. Not a
# setting — it is written to the row once, at creation, and the agent editor owns
# it from then on like any other agent's model.
#
# Note for anyone retargeting it: GLM is the named motivating case for
# ``openai_supports_tool_choice_required=False`` (``agents/tolerant_model.py``),
# which is why the seeded row ships ``ToolChoice.auto``.
DEFAULT_ASSISTANT_MODEL = "openrouter:z-ai/glm-5.2"

ASSISTANT_AGENT_INSTRUCTIONS = """\
You are the user's assistant inside Lursor. You are not scoped to one project —
you help them run the app itself, and you keep notes and one-off scripts in this
workspace.

Answer plainly and act rather than proposing. When a request touches something
outside this workspace, use the tools rather than describing what the user could
click.
"""


def assistant_dir() -> Path:
    """The Assistant workspace's filesystem root (``settings.assistant_dir``)."""
    return settings.assistant_dir.expanduser()


def is_assistant_workspace(ws: Workspace) -> bool:
    """True for the Assistant's workspace — the one place the control plane runs.

    The single predicate behind the whole feature. ``api/chat.py`` calls it once
    per build to decide whether to pass ``extra_tools``.
    """
    return ws.id == ASSISTANT_WORKSPACE_ID


async def ensure_assistant_records(session: AsyncSession) -> tuple[Workspace, Agent]:
    """Register the Assistant workspace and its starter agent, once.

    Idempotent: safe to run on every boot. Adopts rows that already exist rather
    than adding a second pair, so conversation history survives an upgrade.

    Only the workspace's *path* is re-asserted, and only because ``data_dir`` can
    move under it. Everything else on both rows — names, the agent's model, its
    prompt, its feature toggles — is the user's to change and is written exactly
    once, at creation. A boot that re-asserted them would be a boot that silently
    undid the agent editor.
    """
    directory = assistant_dir()
    directory.mkdir(parents=True, exist_ok=True)
    resolved = str(directory.resolve())

    workspace = (
        await session.execute(select(Workspace).where(Workspace.id == ASSISTANT_WORKSPACE_ID))
    ).scalars().first()
    if workspace is None:
        workspace = Workspace(
            id=ASSISTANT_WORKSPACE_ID,
            name=ASSISTANT_WORKSPACE_NAME,
            description=ASSISTANT_WORKSPACE_DESCRIPTION,
            path=resolved,
        )
        session.add(workspace)
    elif workspace.path != resolved:
        # Not the user's to change (the PATCH route refuses it), but the packaged
        # app and a source run resolve ``data_dir`` differently. Follow it.
        workspace.path = resolved
        session.add(workspace)

    agent = (
        await session.execute(select(Agent).where(Agent.id == ASSISTANT_AGENT_ID))
    ).scalars().first()
    if agent is None:
        agent = Agent(
            id=ASSISTANT_AGENT_ID,
            name=ASSISTANT_AGENT_NAME,
            description="Drives Lursor itself. Edit or replace it like any agent.",
            model=DEFAULT_ASSISTANT_MODEL,
            instructions=ASSISTANT_AGENT_INSTRUCTIONS,
            include_todo=True,
            include_subagents=True,
            include_skills=True,
            include_memory=True,
            include_plan=False,
            web_search=True,
            # It drives the app; it does not QA a dev server.
            browser_qa=False,
            include_video=False,
            include_image=False,
            thinking=ThinkingLevel.off,
            tool_choice=ToolChoice.auto,
        )
        session.add(agent)

    await session.commit()
    await session.refresh(workspace)
    await session.refresh(agent)
    return workspace, agent
