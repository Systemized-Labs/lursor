"""Who the Assistant is, and how to recognise it.

The Assistant needs a :class:`Workspace` row and an :class:`Agent` row because
``Thread.workspace_id`` and ``Thread.agent_id`` are both non-null foreign keys.
Seeding two app-owned rows is far cheaper than making a core FK nullable, and
the Skill Studio already established the pattern (``api/workspaces.py``): a real
row at a known location, a *computed* system flag, and UI that files it
separately from the user's own projects.

Recognition is by **id**, not by name. Both rows carry a stable literal primary
key, so renaming the Assistant in the UI cannot detach it from its privileges,
and — more importantly — naming a user's own agent "Assistant" cannot attach
them.
"""

from __future__ import annotations

from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

from app.config import get_settings
from app.db.models import Agent, ThinkingLevel, ToolChoice, Workspace

settings = get_settings()

# Stable primary keys. Deliberately not uuids: recognition is an id comparison in
# a hot path (every turn), and a literal makes the seeded rows obvious in a
# ``sqlite3`` session.
ASSISTANT_AGENT_ID = "lursor-assistant"
ASSISTANT_WORKSPACE_ID = "lursor-assistant-ws"

ASSISTANT_AGENT_NAME = "Assistant"
ASSISTANT_WORKSPACE_NAME = "Assistant"
ASSISTANT_WORKSPACE_DESCRIPTION = (
    "The Assistant's own scratch space. Notes, one-off scripts and exported "
    "reports live here; the app itself is driven by its control-plane tools."
)

# GLM 5.2 through OpenRouter. Overridable in Settings → Model (``AppConfig.
# assistant_model``); this is only the value an unset setting inherits.
#
# Note for anyone retargeting this: GLM is the named motivating case for
# ``openai_supports_tool_choice_required=False`` (``agents/tolerant_model.py``),
# which is why the seeded row pins ``ToolChoice.auto`` below and why nothing in
# the assistant build path forces a tool call.
DEFAULT_ASSISTANT_MODEL = "openrouter:z-ai/glm-5.2"


def assistant_dir() -> Path:
    """The Assistant's filesystem root (``settings.assistant_dir``)."""
    return settings.assistant_dir.expanduser()


def is_assistant_workspace(ws: Workspace) -> bool:
    """True for the Assistant's own workspace row."""
    return ws.id == ASSISTANT_WORKSPACE_ID


def is_assistant_agent(row: object) -> bool:
    """True for the Assistant's own agent row.

    Takes ``object`` rather than ``Agent`` because the callers that matter are
    holding either an :class:`Agent` or a :class:`Subagent` (the builder treats
    them interchangeably), and a subagent must never test true here.
    """
    return isinstance(row, Agent) and row.id == ASSISTANT_AGENT_ID


async def ensure_assistant_records(session: AsyncSession) -> tuple[Workspace, Agent]:
    """Register the Assistant's workspace and agent, once.

    Idempotent: safe to run on every boot. Adopts rows that already exist rather
    than adding a second pair, so a conversation history survives an upgrade.

    The user owns cosmetic fields on an adopted row (a rename is theirs to keep,
    matching ``ensure_skills_workspace``), but the fields that make the Assistant
    *work* — its path, and the deep-agent flags its tools depend on — are
    re-asserted every boot. Those are not user settings; the only knob the UI
    offers is the model, and that lives on ``AppConfig``, not here.
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
        # The path is not the user's to change (the PATCH route refuses it), but
        # ``data_dir`` can move under them — the packaged app and a source run
        # resolve it differently. Follow it.
        workspace.path = resolved
        session.add(workspace)

    agent = (
        await session.execute(select(Agent).where(Agent.id == ASSISTANT_AGENT_ID))
    ).scalars().first()
    if agent is None:
        agent = Agent(
            id=ASSISTANT_AGENT_ID,
            name=ASSISTANT_AGENT_NAME,
            description="Lursor's own assistant. Drives the app itself.",
            # Null: the effective model is resolved per run from
            # ``AppConfig.assistant_model`` falling back to
            # ``DEFAULT_ASSISTANT_MODEL``. Leaving the column null keeps one
            # source of truth instead of two that can drift.
            model=None,
            # Empty: the system prompt is a code constant (``prompt.py``) so a
            # stray edit cannot disarm the language around destructive tools.
            instructions="",
        )
        session.add(agent)

    # Re-asserted on every boot — see the docstring.
    agent.include_todo = True
    agent.include_subagents = True
    agent.include_skills = True
    agent.include_memory = True
    agent.include_plan = False
    agent.web_search = True
    agent.browser_qa = False  # it drives the app, it does not QA a dev server
    agent.include_video = False
    agent.include_image = False
    agent.thinking = ThinkingLevel.off
    agent.tool_choice = ToolChoice.auto  # never "required" — see DEFAULT_ASSISTANT_MODEL
    session.add(agent)

    await session.commit()
    await session.refresh(workspace)
    await session.refresh(agent)
    return workspace, agent
