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
from sqlalchemy import Enum as SAEnum
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


# Skills are no longer linked per-agent (see :class:`Skill`): they are discovered
# by *scope* (global + workspace) at build time. Tools remain per-agent for now.


class AgentToolLink(SQLModel, table=True):
    __tablename__ = "agent_tools"
    agent_id: str = Field(foreign_key="agents.id", primary_key=True)
    tool_id: str = Field(foreign_key="tools.id", primary_key=True)


class SubagentToolLink(SQLModel, table=True):
    __tablename__ = "subagent_tools"
    subagent_id: str = Field(foreign_key="subagents.id", primary_key=True)
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


class ToolChoice(StrEnum):
    """How the model's tool use is constrained for an agent.

    ``auto`` — the model decides (default). ``required`` — force a tool call on
    the opening step, then release to auto so the run can still finish. ``none``
    — forbid tool calls; the model replies with text only. See
    ``agents/builder.py`` for how ``required``/``none`` are enforced."""

    auto = "auto"
    required = "required"
    none = "none"


class ThreadMode(StrEnum):
    """How a thread is driven. Retained for backward compatibility only.

    Modes are no longer sticky: ``/ask``, ``/goal`` and ``/plan`` are all per-turn
    intents forwarded on the request (see ``api/chat.py``), so live threads stay at
    the ``chat`` default. ``plan`` and ``goal`` remain here so rows written by older
    (sticky-mode) builds still load; they behave as plain ``chat`` threads now."""

    chat = "chat"
    plan = "plan"
    goal = "goal"


class ThreadStatus(StrEnum):
    """Lifecycle of a ``plan``/``goal`` thread's run (``goal_status`` on the wire).

    ``idle`` — not in a plan/goal run (or a plain chat thread). A ``/plan`` turn:
    ``planning`` (drafts the plan) → ``awaiting_approval`` (parked; the user reviews
    the plan doc and may send another ``/plan`` to refine it). Sending a plain chat
    turn carries the plan out and clears the park back to ``idle``. ``/goal``:
    ``running`` (autonomous loop).
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


class SkillOrigin(StrEnum):
    """Where a skill folder physically lives, which decides how it is assigned.

    ``managed`` — the canonical store (``settings.skills_dir``,
    ``~/.lursor/skills/<slug>/``). One copy, wherever it applies: a managed skill
    carries an *assignment* (``is_global``, or rows in
    :class:`SkillWorkspaceLink`), so it can be re-pointed at any set of
    workspaces without moving files.

    ``local`` — discovered in one of the workspace's skill roots
    (``settings.local_skill_roots``: ``.agents/skills``, ``.claude/skills``,
    ``.cursor/skills``), recorded in ``Skill.root``. It travels with the workspace
    directory (git-shareable, the Claude Code convention) and applies only there,
    so it has no assignment to edit. ``POST /skills/{id}/promote`` moves the folder
    into the canonical store, but only from ``.agents/skills`` — a root another
    tool owns is copied (``POST /skills/{id}/copy``), never moved.

    ``external`` — discovered in a personal skills directory owned by another tool
    (``~/.claude/skills``, ``settings.user_skill_roots``). Read in place, in scope
    everywhere at the lowest precedence, carries no assignment.
    ``POST /skills/{id}/copy`` duplicates it into the catalog; nothing here ever
    moves or rewrites it implicitly.
    """

    managed = "managed"
    local = "local"
    external = "external"


class SkillWorkspaceLink(SQLModel, table=True):
    """A managed skill's assignment to one workspace.

    Rows exist only for ``origin == "managed"`` skills that are not
    ``is_global`` (global already covers every workspace, so the API clears these
    when global is set). No rows and not global means "in the catalog, injected
    nowhere" — a deliberate parked state, not an error.
    """

    __tablename__ = "skill_workspaces"
    skill_id: str = Field(foreign_key="skills.id", primary_key=True)
    workspace_id: str = Field(foreign_key="workspaces.id", primary_key=True)


class Skill(TimestampMixin, table=True):
    """Index row for an on-disk skill folder (Anthropic skill standard).

    The source of truth is the folder ``<root>/<slug>/`` containing a ``SKILL.md``
    (+ optional resources and ``scripts/``), where ``<root>`` depends on the
    :class:`SkillOrigin`; see ``app/skills/store.py``. Skills are **not** linked
    to agents — an agent discovers whatever is in scope for the workspace it runs
    in (see ``app/skills/resolve.py``), gated only by its ``include_skills``
    toggle. This row exists so listing is cheap, so the UI has a stable id, and so
    assignments and env vars have something to hang off;
    ``name``/``description``/``content`` are a cache of the folder's contents,
    refreshed from disk on reconcile (``api/skills.py``).

    Identity is ``(origin, workspace_id, root, slug)`` — a workspace may
    legitimately redefine a managed skill's slug with a local one (that is the
    collision case, resolved at build time: closest layer wins), and with several
    candidate roots per workspace the same slug can exist twice within the local
    layer too. ``workspace_id`` is the owning workspace for a ``local`` skill and
    is null for a ``managed`` or ``external`` one; a managed skill's reach is
    ``is_global`` plus its :class:`SkillWorkspaceLink` rows.

    The legacy ``scope`` column (``"global"``/``"workspace"``) is dormant: it is
    still present in existing databases and is what ``origin``/``is_global`` were
    backfilled from (``db/session.py``), but nothing reads it any more.
    """

    __tablename__ = "skills"

    slug: str = Field(default="", index=True)  # folder name; disk identity
    name: str = Field(index=True)
    description: str = ""
    content: str = ""  # cached markdown body (disk is authoritative)
    # Store the enum's *value*, not its member name, so the column stays readable
    # and matches what the migration/API write (a plain VARCHAR value).
    origin: SkillOrigin = Field(
        default=SkillOrigin.managed,
        sa_column=Column(
            SAEnum(
                SkillOrigin,
                name="skillorigin",
                values_callable=lambda enum: [m.value for m in enum],
            ),
            nullable=False,
            index=True,
            server_default=SkillOrigin.managed.value,
        ),
    )
    # Managed skills only: applies in every workspace. Mutually exclusive with
    # SkillWorkspaceLink rows by API normalization, not by schema.
    is_global: bool = Field(default=False, index=True)
    # Owning workspace for a local skill; null for managed/external.
    workspace_id: str | None = Field(default=None, foreign_key="workspaces.id", index=True)
    # Which root the folder lives in: the workspace-relative subdir for ``local``
    # (".claude/skills"), the absolute path for ``external``, empty for
    # ``managed`` (the catalog is the only managed root). Stored rather than
    # probed — with three candidate roots per workspace the same slug can exist
    # twice, and probing in order would resolve an edit or a delete to the wrong
    # file. ``server_default`` so a row inserted outside the ORM (and the
    # ``ADD COLUMN`` in db/session.py) lands on the catalog rather than NULL.
    root: str = Field(default="", index=True, sa_column_kwargs={"server_default": ""})
    # When off, this skill is kept and still shown/editable in the manager but is
    # excluded from every run, whatever its layer. This is the only off switch a
    # ``local`` or ``external`` skill has — those carry no assignment, so before
    # this the only way to stop a discovered skill loading was to delete the
    # folder. For a managed skill it is a second axis alongside assignment:
    # "parked" (assigned nowhere) says where, this says whether.
    enabled: bool = Field(default=True, sa_column_kwargs={"server_default": "1"})


class EnvVar(TimestampMixin, table=True):
    """One environment variable Lursor injects into agent runs.

    A var is *assigned* rather than owned: it can be marked ``is_global``
    (every run), linked to workspaces (:class:`EnvVarWorkspaceLink`), and linked
    to skills (:class:`EnvVarSkillLink`) — any mix. At run time the layers merge
    global → workspace → skill, with the later layer winning; see
    ``app/envvars/resolve.py``.

    ``key`` is deliberately **not** unique: the same name may legitimately hold
    different values at different layers (a per-workspace ``DATABASE_URL`` over a
    global fallback). Uniqueness is enforced per layer by the API instead — one
    row per key among globals, per ``(key, workspace)``, and per ``(key, skill)``
    — so precedence is always well defined.

    ``value`` is stored in plaintext, like every other secret this app holds
    (:class:`GitHubConfig.token`, :class:`LaiosConnection.master_key`, provider
    keys). It is never returned by the API for a secret var — reads expose
    ``has_value`` only — and injected values are redacted out of shell output
    before they can reach the transcript (``agents/deduping_backend.py``).
    """

    __tablename__ = "env_vars"

    key: str = Field(index=True)  # POSIX name: ^[A-Za-z_][A-Za-z0-9_]*$
    value: str = ""
    description: str = ""
    # False for non-sensitive config (a region, a feature flag): the value is then
    # readable in the UI and excluded from output redaction.
    is_secret: bool = Field(default=True)
    is_global: bool = Field(default=False, index=True)


class EnvVarWorkspaceLink(SQLModel, table=True):
    """Assignment of an env var to one workspace (applies to every run there)."""

    __tablename__ = "env_var_workspaces"
    env_var_id: str = Field(foreign_key="env_vars.id", primary_key=True)
    workspace_id: str = Field(foreign_key="workspaces.id", primary_key=True)


class EnvVarSkillLink(SQLModel, table=True):
    """Assignment of an env var to one skill.

    Injected whenever that skill is in scope for the run, and — precisely — into
    ``run_skill_script`` for that skill's own scripts (see
    ``app/skills/script_exec.py``), so one skill's scripts never see another
    skill's secrets.
    """

    __tablename__ = "env_var_skills"
    env_var_id: str = Field(foreign_key="env_vars.id", primary_key=True)
    skill_id: str = Field(foreign_key="skills.id", primary_key=True)


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
    subagents: list["Subagent"] = Relationship(
        back_populates="tools",
        link_model=SubagentToolLink,
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
    # Give this agent a headless browser to see and test the app it builds (see
    # ``browser_qa.py``). On by default to match prior behaviour; still gated at
    # run time by the app-wide ``settings.browser_qa_enabled`` master switch and to
    # non-read-only, workspace-scoped runs.
    browser_qa: bool = True
    thinking: ThinkingLevel = Field(default=ThinkingLevel.off)
    # Force or forbid tool calls (see ToolChoice); "auto" leaves it to the model.
    tool_choice: ToolChoice = Field(default=ToolChoice.auto)

    # Escape hatch for future kwargs without a schema change.
    extra_config: dict = Field(default_factory=dict, sa_column=Column(JSON))

    # Skills are not linked here — they are discovered by scope (global +
    # workspace) at build time, gated by ``include_skills`` above.
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

    # Full deep-agent feature toggles, identical to :class:`Agent`. By default the
    # pydantic-deep library builds subagents with a stripped-down factory (no
    # skills/memory/plan/nesting, thinking off) to save tokens; the builder gives
    # each subagent its own factory so these knobs take effect (see
    # ``agents/builder.py``). ``include_skills`` gates scope-discovered skills.
    include_todo: bool = True
    include_subagents: bool = False
    include_skills: bool = True
    include_memory: bool = False
    include_plan: bool = False
    web_search: bool = False
    thinking: ThinkingLevel = Field(default=ThinkingLevel.off)
    tool_choice: ToolChoice = Field(default=ToolChoice.auto)

    # When off, this subagent is kept in the roster (still shown/editable in the
    # UI) but excluded from every agent's specialist set at build time. Lets a
    # user park a subagent without deleting it. Built-in overrides ignore this and
    # are toggled via ``AppConfig.deep_defaults["disabled_builtins"]`` instead.
    enabled: bool = True

    # Escape hatch for future kwargs without a schema change (mirrors Agent).
    extra_config: dict = Field(default_factory=dict, sa_column=Column(JSON))

    # When set, this row is not a user-authored subagent but an *override* of a
    # pydantic-deep built-in of the same name (e.g. "general-purpose", "research").
    # Override rows are managed in the Subagents "Defaults" area, hidden from the
    # normal roster listing, and win over the library default at build time.
    builtin_name: str | None = Field(default=None, index=True)

    # Like :class:`Agent`, subagents discover skills by scope at build time (no
    # per-subagent link); ``include_skills`` gates whether they get any.
    tools: list[Tool] = Relationship(
        back_populates="subagents",
        link_model=SubagentToolLink,
        sa_relationship_kwargs={"lazy": "selectin"},
    )


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
    # Fallback model IDs for endpoints that serve inference but don't expose a
    # usable ``/models`` (auth-gated or simply unimplemented). Comma- or
    # newline-separated; used only when discovery yields nothing, so a provider
    # whose catalogue *is* readable keeps updating itself automatically.
    manual_models: str = ""

    def manual_model_ids(self) -> list[str]:
        """Split :attr:`manual_models` into a clean list of model IDs."""
        entries = self.manual_models.replace("\n", ",").split(",")
        return [entry.strip() for entry in entries if entry.strip()]


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

    # App-wide web-search backend used by every agent that has web search
    # enabled. One of "native" | "duckduckgo" | "tavily" | "exa" (see
    # ``agents/web_search.py``). Null means the default (DuckDuckGo). Tavily/Exa
    # additionally need an API key below.
    web_search_provider: str | None = None
    tavily_api_key: str | None = None
    exa_api_key: str | None = None

    # Model that judges goal-mode completion (see ``agents/goal_loop.py``). The
    # pydantic-deep default is an ``anthropic:`` model that needs a key Lursor
    # may not have, so this overrides it with something on the OpenRouter/custom
    # stack. When null the loop falls back to the thread agent's own model.
    goal_evaluator_model: str | None = None

    # Per-app override for the ``/compact`` summarization model (see
    # ``agents/compaction.py``). When null, compaction uses the global
    # ``settings.default_compaction_model`` — a small/fast cloud model — rather
    # than the (possibly heavy or offline) thread agent's model.
    compaction_model: str | None = None

    # Default agent per slash command, keyed by command ("chat" | "ask" | "plan"
    # | "goal") → agent id. When a command has an entry, using it in the composer
    # switches to (and, for an open thread, reassigns) that agent; the agent
    # brings its own model/tools/instructions. A missing/blank key means "no
    # default — keep the current agent". Kept as a free-form JSON blob so the set
    # of commands can grow without a schema migration.
    default_agents: dict = Field(default_factory=dict, sa_column=Column(JSON))

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

    # --- Plan / goal mode ----------------------------------------------------
    # A ``chat`` thread ignores every field below. ``plan`` mode drafts a plan
    # and waits for approval; ``goal`` mode runs the self-continuing loop in
    # ``agents/goal_loop.py`` (work → evaluate → repeat) until ``status`` reaches
    # a terminal state. Modes are entered by a slash command (see the frontend
    # command registry).
    mode: ThreadMode = Field(default=ThreadMode.chat)
    goal: str = ""  # the objective the agent works toward (goal mode)
    # The completion condition handed to the evaluator; falls back to ``goal``
    # when empty. Kept separate so "what to do" and "what "done" means" can differ.
    success_criteria: str = ""
    status: ThreadStatus = Field(default=ThreadStatus.idle)
    # Workspace-relative path of this plan thread's on-disk doc (plan mode). Set on
    # the first planning turn (``.agents/plan/PLAN-<slug>.md``) and reused across
    # refinement turns; empty for chat/goal threads. Lets the UI open the exact
    # plan file instead of a shared ``PLAN.md``.
    plan_path: str = ""
    iteration: int = 0  # evaluation turns spent (mirrors GoalState.turns)
    max_iterations: int = 25  # hard safety cap → GoalState.max_turns
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
    # How a user turn was sent, for a history badge: "chat" (plain) | "ask"
    # (read-only) | "plan" (a plan-mode turn) | "goal" (a one-off goal run).
    # Assistant/tool rows keep the default and render no badge.
    kind: str = Field(default="chat")
    # The agent that ran this turn, snapshotted at write time so the transcript
    # shows which agent handled it even after the thread's agent is switched — and
    # survives an agent rename/delete. ``agent_id`` is the row id (null for legacy
    # rows and system messages); ``agent_name`` is the display-name snapshot the UI
    # renders on the bubble.
    agent_id: str | None = None
    agent_name: str = Field(default="")
    # Assistant tool calls made during this turn, insertion-ordered:
    # ``[{id, name, arguments, result}]``. Persisted so a reloaded thread shows the
    # same tool blocks that streamed in live (see api/chat.py ``_collect_tool_call``).
    # Legacy rows may hold an empty dict; ``MessageRead`` coerces that to ``[]``.
    tool_calls: list = Field(default_factory=list, sa_column=Column(JSON))
    # Media attached to this turn: list of {media_id, mime_type, filename}. The
    # bytes live on disk (see app.media_store); this only holds references.
    attachments: list = Field(default_factory=list, sa_column=Column(JSON))
    # Rolled into an earlier ``/compact`` summary and hidden from the thread going
    # forward. The row is kept (never deleted) so history isn't lost, but it is
    # excluded from the messages the UI shows and the context sent to the model —
    # its content now lives condensed in the ``kind="summary"`` message that
    # replaced it. See ``agents/compaction.py`` and the compact endpoint.
    compacted: bool = Field(default=False, index=True)

    thread: Thread | None = Relationship(back_populates="messages")


class UsageRecord(TimestampMixin, table=True):
    """Token consumption + cost for a single agent turn.

    One row is written per completed turn (see ``api/chat.py``'s ``on_complete``),
    carrying enough foreign keys to roll usage up by model, workspace, agent, or
    thread — and over time via ``created_at``. ``cost_usd`` is derived from the
    OpenRouter pricing catalogue (``app/pricing.py``); local/custom models resolve
    to ``0.0`` because they have no per-token price.
    """

    __tablename__ = "usage_records"

    thread_id: str = Field(foreign_key="threads.id", index=True)
    workspace_id: str = Field(foreign_key="workspaces.id", index=True)
    agent_id: str = Field(foreign_key="agents.id", index=True)
    # Raw model string as stored on the agent (e.g. ``openrouter:qwen/qwen3-max``).
    model: str = Field(default="", index=True)
    # Which kind of turn produced this: chat | goal | plan | vision.
    kind: str = Field(default="chat", index=True)

    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    requests: int = 0
    cost_usd: float = 0.0

    # Raw RunUsage extras (per-provider detail dicts), kept for future breakdowns.
    usage_details: dict = Field(default_factory=dict, sa_column=Column(JSON))
