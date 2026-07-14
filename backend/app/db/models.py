"""Database models (SQLModel tables).

Domain: an :class:`Agent` is configured once and can be attached to many
:class:`Workspace` s (a workspace is a directory on disk). Agents own reusable
:class:`Skill` s and :class:`Tool` s. Conversations are :class:`Thread` s that
hold :class:`Message` s.

Every table carries a nullable ``user_id`` so single-user-now can become
multi-tenant later without a migration.
"""

import uuid
from datetime import UTC, datetime
from enum import StrEnum

from sqlalchemy import JSON, Column
from sqlmodel import Field, Relationship, SQLModel


def _uuid() -> str:
    return uuid.uuid4().hex


def _now() -> datetime:
    return datetime.now(UTC)


class TimestampMixin(SQLModel):
    """Shared identity, ownership, and audit columns."""

    id: str = Field(default_factory=_uuid, primary_key=True)
    user_id: str | None = Field(default=None, index=True)
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


# --- Link tables (many-to-many) -------------------------------------------------


class AgentSkillLink(SQLModel, table=True):
    __tablename__ = "agent_skills"
    agent_id: str = Field(foreign_key="agents.id", primary_key=True)
    skill_id: str = Field(foreign_key="skills.id", primary_key=True)


class AgentToolLink(SQLModel, table=True):
    __tablename__ = "agent_tools"
    agent_id: str = Field(foreign_key="agents.id", primary_key=True)
    tool_id: str = Field(foreign_key="tools.id", primary_key=True)


# --- Core entities --------------------------------------------------------------


class ToolKind(StrEnum):
    builtin = "builtin"
    mcp = "mcp"
    http = "http"


class ThinkingLevel(StrEnum):
    off = "off"
    low = "low"
    medium = "medium"
    high = "high"


class ThreadMode(StrEnum):
    """How a thread is driven. ``chat`` is the classic turn-based conversation;
    ``goal`` runs the self-continuing goal loop (see ``agents/goal_loop.py``)."""

    chat = "chat"
    goal = "goal"


class GoalStatus(StrEnum):
    """Lifecycle of a goal-mode thread's objective.

    ``idle`` — not pursuing a goal (or a chat thread). Then, in order:
    ``planning`` (first turn drafts the checklist) → ``awaiting_approval``
    (paused for the user to approve the plan) → ``running`` (autonomous loop).
    Terminal: ``completed`` (evaluator confirmed), ``blocked`` (judged
    impossible / needs a human), ``failed`` (hit the iteration cap), ``stopped``
    (cancelled by the user)."""

    idle = "idle"
    planning = "planning"
    awaiting_approval = "awaiting_approval"
    running = "running"
    completed = "completed"
    blocked = "blocked"
    failed = "failed"
    stopped = "stopped"


class Skill(TimestampMixin, table=True):
    """Index row for an on-disk skill folder (Anthropic skill standard).

    The source of truth is the folder ``<skills_dir>/<slug>/`` containing a
    ``SKILL.md`` (+ optional resources and ``scripts/``); see ``app/skills/store.py``.
    This row exists so agents can link to a skill by a stable id and so listing is
    cheap. ``name``/``description``/``content`` are a cache of the folder's
    contents, refreshed from disk on reconcile (``api/skills.py``).
    """

    __tablename__ = "skills"

    slug: str = Field(default="", index=True)  # folder name; disk identity
    name: str = Field(index=True)
    description: str = ""
    content: str = ""  # cached markdown body (disk is authoritative)

    agents: list["Agent"] = Relationship(
        back_populates="skills",
        link_model=AgentSkillLink,
        sa_relationship_kwargs={"lazy": "selectin"},
    )


class PromptTemplate(TimestampMixin, table=True):
    """A reusable system-prompt template, applied by copying into ``Agent.instructions``.

    Unlike :class:`Skill`, a template is not linked to agents — it is a starting
    point that gets copied into an agent's instructions, so the agent stays
    self-contained and freely editable afterwards. ``is_builtin`` marks the
    curated set seeded from ``scripts/seed.py`` (read-only in the UI; users
    duplicate one to customize it).
    """

    __tablename__ = "prompt_templates"

    name: str = Field(index=True)
    description: str = ""
    category: str = Field(default="general", index=True)
    content: str = ""  # the system-prompt body
    is_builtin: bool = Field(default=False, index=True)


class Tool(TimestampMixin, table=True):
    """A capability the agent can call: a builtin, an MCP server, or an HTTP tool."""

    __tablename__ = "tools"

    name: str = Field(index=True)
    description: str = ""
    kind: ToolKind = Field(default=ToolKind.builtin)
    config: dict = Field(default_factory=dict, sa_column=Column(JSON))

    agents: list["Agent"] = Relationship(
        back_populates="tools",
        link_model=AgentToolLink,
        sa_relationship_kwargs={"lazy": "selectin"},
    )


class Agent(TimestampMixin, table=True):
    """A configured deep agent. Rendered into ``create_deep_agent(...)`` at run time."""

    __tablename__ = "agents"

    name: str = Field(index=True)
    description: str = ""
    model: str | None = None  # falls back to settings.default_model when null
    instructions: str = ""  # system prompt

    # Deep-agent feature toggles (map 1:1 to create_deep_agent kwargs).
    include_todo: bool = True
    include_subagents: bool = False
    include_skills: bool = True
    include_memory: bool = False
    include_plan: bool = False
    web_search: bool = False
    thinking: ThinkingLevel = Field(default=ThinkingLevel.off)

    # Escape hatch for future kwargs without a schema change.
    extra_config: dict = Field(default_factory=dict, sa_column=Column(JSON))

    skills: list[Skill] = Relationship(
        back_populates="agents",
        link_model=AgentSkillLink,
        sa_relationship_kwargs={"lazy": "selectin"},
    )
    tools: list[Tool] = Relationship(
        back_populates="agents",
        link_model=AgentToolLink,
        sa_relationship_kwargs={"lazy": "selectin"},
    )


class Subagent(TimestampMixin, table=True):
    """A globally-defined subagent, delegatable by any agent with subagents on.

    Rendered into a pydantic-deep ``SubAgentConfig`` at run time (see
    ``agents/builder.py``) and offered to the parent agent's task tool as a
    specialist it can hand work to. Unlike :class:`Skill`/:class:`Tool`, these
    are not linked per-agent: the whole set applies globally so the harness
    keeps one consistent roster of specialists. An agent only receives them
    when its ``include_subagents`` flag is on.
    """

    __tablename__ = "subagents"

    name: str = Field(index=True)
    description: str = ""  # shown to the parent agent when choosing a specialist
    instructions: str = ""  # the subagent's system prompt
    model: str | None = None  # optional override; falls back to the parent's model

    # When set, this row is not a user-authored subagent but an *override* of a
    # pydantic-deep built-in of the same name (e.g. "general-purpose", "research").
    # Override rows are managed in the Subagents "Defaults" area, hidden from the
    # normal roster listing, and win over the library default at build time.
    builtin_name: str | None = Field(default=None, index=True)


class CustomProvider(TimestampMixin, table=True):
    """A user-added, locally-hosted OpenAI-compatible model endpoint.

    Local runtimes (Ollama, LM Studio, vLLM, llama.cpp, …) all expose an
    OpenAI-compatible REST API, so a base URL plus an optional API key is enough
    to both list the endpoint's models and route runs to it. Selected models are
    stored on an agent as ``custom:{provider_id}:{model_name}`` (see
    ``agents/builder.py``).
    """

    __tablename__ = "custom_providers"

    name: str = Field(index=True)  # display name, e.g. "Local Ollama"
    base_url: str = ""  # OpenAI-compatible base, e.g. "http://localhost:11434/v1"
    api_key: str | None = None  # optional; local servers usually don't require one


class LaiosConnection(TimestampMixin, table=True):
    """A connection to a laios daemon control plane (``:7420``).

    laios is a local-first inference OS: its Rust daemon owns the catalog,
    model pull/serve lifecycle, VRAM budget, and cluster. Unlike a
    :class:`CustomProvider` (which points at the OpenAI-compatible *inference*
    gateway on ``:4000``), this points at the *control* plane and carries the
    ``master_key`` used as a Bearer token on every ``/v1/*`` call. Daemons may
    be remote, so several connections can coexist; the backend proxies to the
    selected one (see ``api/laios.py``). The ``master_key`` is stored
    server-side only and never returned to the browser.
    """

    __tablename__ = "laios_connections"

    name: str = Field(index=True)  # display name, e.g. "local" or "spark-head"
    base_url: str = ""  # daemon control-plane base, e.g. "http://127.0.0.1:7420"
    master_key: str | None = None  # Bearer token for /v1/*; kept server-side
    # The CustomProvider auto-managed for this connection so its served models
    # flow into the model picker (points at the daemon's LiteLLM gateway). Kept
    # on this (new) table so CustomProvider needs no migration.
    linked_provider_id: str | None = None


class AppConfig(TimestampMixin, table=True):
    """App-wide settings editable from the UI (single row for this single-user app).

    Currently holds the OpenRouter API key. When set it overrides the value from
    the environment / ``.env`` and is applied to the running process so model
    listing and agent runs pick it up without a restart (see ``api/settings.py``).
    """

    __tablename__ = "app_config"

    openrouter_api_key: str | None = None

    # Model that judges goal-mode completion (see ``agents/goal_loop.py``). The
    # pydantic-deep default is an ``anthropic:`` model that needs a key Lursor
    # may not have, so this overrides it with something on the OpenRouter/custom
    # stack. When null the loop falls back to the thread agent's own model.
    goal_evaluator_model: str | None = None

    # Global overrides for pydantic-deep defaults. Currently scoped to subagents:
    #   {"max_nesting_depth": int, "disabled_builtins": ["research", ...]}
    # A key that is absent means "inherit the library default" (see
    # ``agents/deep_defaults.py``). Kept as a free-form JSON blob so new knobs can
    # be exposed without a schema migration.
    deep_defaults: dict = Field(default_factory=dict, sa_column=Column(JSON))


class GitHubConfig(TimestampMixin, table=True):
    """The user's GitHub connection (single row for this single-user app).

    Stores a personal access token plus the identity resolved from it. On save
    the token is also written into git's global credential store so that clone,
    push, and pull work everywhere — the backend clone endpoint, the terminal
    panel, and the agent's own shell — without re-prompting.
    """

    __tablename__ = "github_config"

    token: str = ""  # personal access token (classic or fine-grained)
    login: str | None = None  # GitHub username resolved from the token
    name: str | None = None  # git user.name / GitHub display name
    email: str | None = None  # git user.email
    avatar_url: str | None = None


class Workspace(TimestampMixin, table=True):
    """A named directory on disk that scopes an agent's filesystem."""

    __tablename__ = "workspaces"

    name: str = Field(index=True)
    description: str = ""
    path: str = ""  # absolute path, assigned on creation


class Thread(TimestampMixin, table=True):
    """A conversation between the user and one agent inside one workspace."""

    __tablename__ = "threads"

    title: str = "New conversation"
    workspace_id: str = Field(foreign_key="workspaces.id", index=True)
    agent_id: str = Field(foreign_key="agents.id", index=True)

    # --- Goal mode -----------------------------------------------------------
    # A ``chat`` thread ignores every field below. A ``goal`` thread runs the
    # self-continuing loop in ``agents/goal_loop.py``: plan → (approve) → work
    # → evaluate → repeat, until ``goal_status`` reaches a terminal state.
    mode: ThreadMode = Field(default=ThreadMode.chat)
    goal: str = ""  # the objective the agent works toward
    # The completion condition handed to the evaluator; falls back to ``goal``
    # when empty. Kept separate so "what to do" and "what "done" means" can differ.
    success_criteria: str = ""
    goal_status: GoalStatus = Field(default=GoalStatus.idle)
    iteration: int = 0  # evaluation turns spent (mirrors GoalState.turns)
    max_iterations: int = 25  # hard safety cap → GoalState.max_turns
    require_plan_approval: bool = True  # pause after planning for user approval
    last_reason: str = ""  # evaluator's latest one-sentence verdict, for the UI
    # Latest todo checklist snapshot, persisted so goal progress survives a
    # reconnect (the live list otherwise lives only in transient run deps).
    todos_snapshot: list = Field(default_factory=list, sa_column=Column(JSON))

    messages: list["Message"] = Relationship(
        back_populates="thread",
        sa_relationship_kwargs={"lazy": "selectin", "cascade": "all, delete-orphan"},
    )


class Message(TimestampMixin, table=True):
    """A single turn in a thread. ``tool_calls`` holds raw AG-UI/tool payloads."""

    __tablename__ = "messages"

    thread_id: str = Field(foreign_key="threads.id", index=True)
    role: str  # "user" | "assistant" | "system" | "tool"
    content: str = ""
    tool_calls: dict = Field(default_factory=dict, sa_column=Column(JSON))
    # Media attached to this turn: list of {media_id, mime_type, filename}. The
    # bytes live on disk (see app.media_store); this only holds references.
    attachments: list = Field(default_factory=list, sa_column=Column(JSON))

    thread: Thread | None = Relationship(back_populates="messages")
