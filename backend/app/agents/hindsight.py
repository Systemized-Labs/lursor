"""Bring-your-own memory layer — Hindsight as an agent-memory provider.

The per-agent ``include_memory`` flag only decides *whether* an agent has
long-term memory; *where* that memory lives is an app-wide choice
(``AppConfig.memory_provider``), mirroring how ``web_search_provider`` separates
"may this agent search" from "which backend does it search with".

Providers:

- ``file``      — pydantic-deep's ``AgentMemoryToolset``: three tools over a
                  single ``MEMORY.md`` inside the workspace, plus recency-truncated
                  injection of that file into the system prompt. The default, and
                  the historical behaviour. Never leaves the machine, but has no
                  retrieval, is trapped in one workspace, and nothing else can
                  read it.
- ``hindsight`` — retain / recall / reflect against a tag-scoped `Hindsight
                  <https://github.com/vectorize-io/hindsight>`_ memory bank
                  (self-hosted or hosted). Entity extraction, temporal anchoring,
                  hybrid retrieval and reflection all happen server-side, and the
                  bank is shared with whatever else the user points at it.

The framing is deliberate: the user points Lursor at a Hindsight instance *they*
own and may already populate from other tools, and Lursor becomes one more reader
and writer of that bank rather than the owner of it. Isolation between workspaces
is therefore a *tag filter* (see :func:`recall_tags`), not a separate bank —
so crossing workspaces, or reading a bank someone else filled, is a settings
change instead of a migration.

The two providers never coexist in one run: when ``hindsight`` is selected the
builder calls ``create_deep_agent(include_memory=False)`` and attaches
:class:`HindsightMemoryCapability` instead, because six memory tools with
overlapping semantics is worse than three. Existing ``MEMORY.md`` files are left
on disk untouched, so switching back is instant and lossless.

Everything here degrades rather than fails. A provider that can't be used at all
(extra not installed, no base URL configured) resolves to ``None``, which the
builder reads as "use file memory", with a warning logged. A *reachable but
failing* service degrades at the tool layer: ``HindsightError`` from a tool comes
back to the model as text via :class:`app.agents.tool_errors.ToolErrorsAsText`,
and a failed prompt injection contributes an empty string.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from pydantic_ai.capabilities import AbstractCapability, ValidatedToolArgs
from pydantic_ai.messages import ToolCallPart
from pydantic_ai.tools import RunContext, ToolDefinition
from pydantic_ai.toolsets import AbstractToolset
from pydantic_ai.toolsets.function import FunctionToolset

from app.config import Settings
from app.db.models import AppConfig

logger = logging.getLogger(__name__)

# The provider used when nothing is configured — pydantic-deep's MEMORY.md, i.e.
# exactly the pre-existing behaviour, so a NULL column upgrades to a no-op.
DEFAULT_MEMORY_PROVIDER = "file"

# Every provider the UI may select. Kept in sync with the frontend
# ``MemoryProvider`` union and the ``MemoryProvider`` schema literal.
MEMORY_PROVIDERS = ("file", "hindsight")
HINDSIGHT_PROVIDER = "hindsight"

# One bank for the whole app; workspace isolation is by tag (see below).
DEFAULT_BANK_ID = "lursor"

DEFAULT_ISOLATION = "workspace"
MEMORY_ISOLATIONS = ("workspace", "shared")

DEFAULT_BUDGET = "mid"
RECALL_BUDGETS = ("low", "mid", "high")
DEFAULT_MAX_TOKENS = 4096

# The probe query used for the once-per-turn auto-injection. Upstream's default
# is "relevant context about the user", which biases toward user facts over
# project facts; a Lursor agent needs both. Configurable per install.
DEFAULT_RECALL_QUERY = "relevant context for the current task and this user"

# Prepended to the injected memory block so the model can tell recalled memory
# apart from its own instructions.
INJECTION_PREFIX = "Relevant memories from your long-term memory:\n"

# How many recalled memories the injection may include.
INJECTION_MAX_RESULTS = 5

# Provenance tag on every memory Lursor writes, so the user (or another tool
# sharing the bank) can tell Lursor's memories apart in Hindsight's own UI.
PROVENANCE_TAG = "lursor"

# Recall-tag matching mode for "workspace" isolation. The ``_strict`` variants
# are the load-bearing choice: plain ``any``/``all`` *include untagged memories*,
# so they would leak every untagged memory in the bank into every workspace.
# ``any_strict`` is a hard SQL-level partition applied before ranking.
STRICT_TAG_MATCH = "any_strict"

# Lifetime of the cached injection block, per built agent.
#
# pydantic-ai re-evaluates instruction callables on *every model request*, so the
# upstream ``memory_instructions`` callable would issue up to ``TURN_REQUEST_LIMIT``
# (150) recalls in one tool-heavy turn, each with server-side retrieval cost. The
# cache collapses that to one recall per turn. The TTL exists for the goal-mode
# loop, which reuses one built agent across many iterations (see
# ``api/chat.py``) — without it, a run lasting an hour would inject memories
# recalled at minute zero.
RECALL_CACHE_TTL = 120.0

# Request timeout for our shared clients. The client default is 300s, which is a
# batch-job figure: an injection blocking the first model call for five minutes
# is indistinguishable from a hung turn.
CLIENT_TIMEOUT = 30.0

# Tool names produced by ``create_hindsight_tools`` — strings the upstream package
# owns, named here so everything that has to agree with them agrees in one place.
# ``builder._READONLY_TOOL_ALLOWLIST`` still spells them literally (its other
# entries do too, and mixing the two styles reads worse); a test asserts the two
# match, so a rename upstream breaks a test rather than silently widening the
# read-only surface.
RETAIN_TOOL = "hindsight_retain"
RECALL_TOOL = "hindsight_recall"
REFLECT_TOOL = "hindsight_reflect"

# Toolset id, mirroring pydantic-deep's ``deep-memory`` so a build can be
# asserted on (and so the two are visibly mutually exclusive).
TOOLSET_ID = "hindsight-memory"

# Appended to the instructions of every agent running on the Hindsight provider.
# The tools are named and described differently from ``read_memory`` /
# ``write_memory``, so an agent whose instructions were written against MEMORY.md
# needs a nudge to use them at all — and the sharing/secrets guidance has no
# equivalent in the file provider, where memory never leaves the machine.
HINDSIGHT_MEMORY_DIRECTIVE = (
    "# Long-term memory\n"
    "- You have persistent memory that outlives this conversation, stored in a "
    "shared memory service rather than a file in the workspace. Relevant "
    "memories are recalled into your context automatically at the start of each "
    "turn.\n"
    "- `hindsight_recall` searches it for facts; `hindsight_reflect` asks it a "
    "question and gets a synthesized answer. Prefer recall for lookups and "
    "reflect when you need a judgement about what you know.\n"
    "- `hindsight_retain` saves something new. Retain durable facts — user "
    "preferences, project conventions, decisions and their rationale, a solved "
    "recurring problem. Do not retain transient state, secrets, credentials, or "
    "file contents you can simply re-read.\n"
    "- Memory is shared with the user's other tools. Write for a reader who does "
    "not have this conversation in front of them."
)


def hindsight_installed() -> bool:
    """Whether the optional ``hindsight`` extra is importable in this process."""
    try:
        import hindsight_pydantic_ai  # noqa: F401
    except ImportError:
        return False
    return True


@dataclass(frozen=True)
class HindsightConfig:
    """Resolved, run-ready Hindsight settings.

    Built once per turn by :func:`resolve_hindsight_config` and threaded into
    ``build_deep_agent``, so a run reads its memory configuration exactly once
    rather than each level of the agent tree re-resolving it.
    """

    base_url: str
    api_key: str | None
    bank_id: str
    isolation: Literal["workspace", "shared"]
    budget: str
    max_tokens: int
    inject_memories: bool
    include_reflect: bool
    recall_query: str
    extra_recall_tags: tuple[str, ...]


def _one_of(value: Any, allowed: tuple[str, ...], default: str) -> str:
    """``value`` when it is one of ``allowed``, else ``default``."""
    if isinstance(value, str) and value.strip().lower() in allowed:
        return value.strip().lower()
    return default


def _positive_int(value: Any, default: int) -> int:
    """``value`` when it is a usable positive int, else ``default``."""
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return default
    return value


def _bool(value: Any, default: bool) -> bool:
    return value if isinstance(value, bool) else default


def _tag_tuple(value: Any) -> tuple[str, ...]:
    """Clean a JSON list of tags into a deduped tuple, preserving order."""
    if not isinstance(value, list):
        return ()
    seen: dict[str, None] = {}
    for item in value:
        if isinstance(item, str) and item.strip():
            seen.setdefault(item.strip(), None)
    return tuple(seen)


def resolve_knobs(blob: dict | None, settings: Settings) -> dict:
    """The effective tuning knobs from a ``hindsight_config`` blob.

    Every key is optional and an absent (or unusable) one falls back to the
    module default, so a partial blob is honoured and a new knob needs no
    migration. Shared with ``api/settings.py``, which has to render the values a
    run *would* use even before the provider is switched over — so this
    deliberately knows nothing about which provider is selected.

    Returns a plain dict whose keys match :class:`HindsightConfig`'s tuning
    fields, so it can be splatted into either that dataclass or the API schema.
    """
    blob = blob or {}

    bank_id = blob.get("bank_id")
    if not isinstance(bank_id, str) or not bank_id.strip():
        bank_id = settings.hindsight_bank_id or DEFAULT_BANK_ID

    recall_query = blob.get("recall_query")
    if not isinstance(recall_query, str):
        recall_query = ""

    return {
        "bank_id": bank_id.strip(),
        "isolation": _one_of(blob.get("isolation"), MEMORY_ISOLATIONS, DEFAULT_ISOLATION),
        "budget": _one_of(blob.get("budget"), RECALL_BUDGETS, DEFAULT_BUDGET),
        "max_tokens": _positive_int(blob.get("max_tokens"), DEFAULT_MAX_TOKENS),
        "inject_memories": _bool(blob.get("inject_memories"), True),
        "include_reflect": _bool(blob.get("include_reflect"), True),
        "recall_query": recall_query.strip(),
        "extra_recall_tags": list(_tag_tuple(blob.get("extra_recall_tags"))),
    }


def resolve_provider(app_config: AppConfig | None) -> str:
    """The configured memory provider name, defaulted and validated."""
    provider = (
        (app_config.memory_provider if app_config else None) or DEFAULT_MEMORY_PROVIDER
    ).strip().lower()
    return provider if provider in MEMORY_PROVIDERS else DEFAULT_MEMORY_PROVIDER


def resolve_hindsight_config(
    app_config: AppConfig | None, settings: Settings
) -> HindsightConfig | None:
    """The Hindsight settings for this run, or ``None`` to use file memory.

    ``None`` is returned — and is the *only* failure signal, because the caller's
    degradation path is then a single branch — when:

    - the provider is not ``hindsight`` (the common case; silent),
    - the optional ``hindsight`` extra is not installed (warned), or
    - no base URL resolves from either the ``AppConfig`` row or the environment
      (warned).

    A value saved in the UI wins over the environment fallback, matching the
    Tavily/Exa key precedence.
    """
    if resolve_provider(app_config) != HINDSIGHT_PROVIDER:
        return None

    if not hindsight_installed():
        logger.warning(
            "memory: provider 'hindsight' selected but the 'hindsight' extra is not "
            "installed (uv sync --extra hindsight); falling back to file memory"
        )
        return None

    base_url = (
        (app_config.hindsight_base_url if app_config else None)
        or settings.hindsight_base_url
        or ""
    ).strip().rstrip("/")
    if not base_url:
        logger.warning(
            "memory: provider 'hindsight' selected but no base URL is configured; "
            "falling back to file memory"
        )
        return None

    api_key = (
        (app_config.hindsight_api_key if app_config else None)
        or settings.hindsight_api_key
        or None
    )

    knobs = resolve_knobs(
        app_config.hindsight_config if app_config else None, settings
    )
    return HindsightConfig(
        base_url=base_url,
        api_key=api_key,
        **{
            **knobs,
            # A blank stored query means "use the default probe", which the API
            # layer renders as an empty field rather than the literal default.
            "recall_query": knobs["recall_query"] or DEFAULT_RECALL_QUERY,
            "extra_recall_tags": tuple(knobs["extra_recall_tags"]),
        },
    )


# --- Client lifecycle ---------------------------------------------------------
# One client per (base_url, api_key), created lazily so it is constructed inside
# the running event loop rather than at import — the same rationale as the shared
# model HTTP clients in ``builder.py``. The transport is aiohttp, which complains
# loudly about sessions left unclosed at interpreter exit, so the cache is drained
# from the FastAPI lifespan (see ``close_hindsight_clients``).

_clients: dict[tuple[str, str | None], Any] = {}


def shared_client(config: HindsightConfig) -> Any:
    """Return the process-wide ``Hindsight`` client for ``config``'s connection."""
    from hindsight_client import Hindsight

    key = (config.base_url, config.api_key)
    client = _clients.get(key)
    if client is None:
        client = Hindsight(
            base_url=config.base_url,
            api_key=config.api_key,
            timeout=CLIENT_TIMEOUT,
            user_agent=user_agent(),
        )
        _clients[key] = client
    return client


def user_agent() -> str:
    """A ``User-Agent`` identifying Lursor to the Hindsight instance."""
    try:
        from importlib import metadata

        version = metadata.version("lursor-backend")
    except Exception:  # noqa: BLE001 - version is cosmetic
        version = "0"
    return f"lursor/{version}"


# Banks we have already confirmed exist, keyed by ``base_url|bank_id`` so one
# process talking to two instances doesn't confuse them.
_ensured_banks: set[str] = set()


async def close_hindsight_clients() -> None:
    """Close every cached client. Called from the app lifespan on shutdown."""
    clients = list(_clients.values())
    _clients.clear()
    # A new client for the same bank must re-verify it: the old client's
    # conclusion belonged to a connection that no longer exists.
    _ensured_banks.clear()
    for client in clients:
        with contextlib.suppress(Exception):
            await client.aclose()


async def ensure_bank(client: Any, config: HindsightConfig) -> None:
    """Best-effort: make sure ``config.bank_id`` exists on the instance.

    Whether ``retain`` auto-creates a missing bank is not documented upstream, so
    this closes the gap without depending on the answer. It deliberately *lists*
    banks first and only creates when the bank is genuinely absent: bank creation
    is a ``PUT`` that doubles as an update, and the whole premise here is that the
    bank may be one the user already owns and configured from somewhere else — so
    we never write to an existing one.

    Runs at most once per process per bank, and swallows every failure: a bank
    that can't be checked is not a reason to fail a turn, because the tools
    themselves report their own errors to the model.
    """
    key = f"{config.base_url}|{config.bank_id}"
    if key in _ensured_banks:
        return
    # Recorded up front, not on success: a failing instance must not mean a
    # probe on every single turn.
    _ensured_banks.add(key)
    try:
        listing = await client.banks.list_banks()
        if any(bank.bank_id == config.bank_id for bank in listing.banks):
            return
        await client.acreate_bank(config.bank_id)
        logger.info("memory: created Hindsight bank %r", config.bank_id)
    except Exception as exc:  # noqa: BLE001 - bootstrap is best-effort
        logger.warning(
            "memory: could not verify or create Hindsight bank %r: %s",
            config.bank_id,
            exc,
        )


# --- Tags — how isolation actually works --------------------------------------


def slugify(value: str) -> str:
    """A lowercase, hyphenated tag-safe form of ``value`` (``""`` when unusable).

    Runs of anything that isn't alphanumeric collapse to a single hyphen, so an
    existing hyphen or underscore in the name is normalized rather than doubled.
    """
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def workspace_tag_id(
    workspace_id: str | None, workspace_path: str | Path | None
) -> str | None:
    """The stable identifier a workspace's memories are tagged with.

    Prefers the workspace **id** so a rename can't orphan its memories. Callers
    without one (subagents, and the handful of entry points that build an agent
    outside a workspace request) fall back to the resolved path's basename, which
    is stable for our workspaces because each is a directory named by its id.
    """
    if workspace_id:
        return workspace_id
    if workspace_path:
        name = Path(workspace_path).name
        return name or None
    return None


def retain_tags(
    *,
    workspace_id: str | None,
    workspace_name: str | None,
    workspace_path: str | Path | None,
    agent_name: str | None,
) -> tuple[str, ...]:
    """Tags written onto every memory this run retains.

    Unconditional — they do not vary with ``isolation`` — so switching isolation
    later is a settings change rather than a data migration.

    - ``lursor`` marks provenance in a bank that may be shared with other tools.
    - ``workspace:{id}`` is the scope filter :func:`recall_tags` matches on.
    - ``workspace-name:{slug}`` is a human-readable label for browsing Hindsight's
      own UI. Never filtered on.
    - ``agent:{slug}`` attributes the memory to the agent that wrote it.
    """
    tags = [PROVENANCE_TAG]
    scope = workspace_tag_id(workspace_id, workspace_path)
    if scope:
        tags.append(f"workspace:{scope}")
    label = slugify(workspace_name or "")
    if label:
        tags.append(f"workspace-name:{label}")
    agent_slug = slugify(agent_name or "")
    if agent_slug:
        tags.append(f"agent:{agent_slug}")
    return tuple(tags)


def recall_tags(
    config: HindsightConfig,
    *,
    workspace_id: str | None,
    workspace_path: str | Path | None,
) -> tuple[str, ...]:
    """Tags a recall is filtered to — ``()`` meaning "no filter, the whole bank".

    - ``workspace`` isolation (the default) partitions the bank: only memories
      tagged for this workspace, plus anything in ``extra_recall_tags``, come
      back. That last one is the deliberate escape hatch — tag something
      ``shared`` from Hindsight's UI or another tool, add ``shared`` here, and it
      crosses workspaces.
    - ``shared`` isolation applies no filter at all: the whole bank is in scope
      for every workspace. This is the "I already have a memory bank, read all of
      it" mode, and it is what makes an externally-populated bank work with no
      setup.
    """
    if config.isolation == "shared":
        return ()
    tags: list[str] = []
    scope = workspace_tag_id(workspace_id, workspace_path)
    if scope:
        tags.append(f"workspace:{scope}")
    tags.extend(t for t in config.extra_recall_tags if t not in tags)
    return tuple(tags)


# --- The capability -----------------------------------------------------------


@dataclass
class HindsightMemoryCapability(AbstractCapability[Any]):
    """Long-term memory backed by a Hindsight bank.

    Construct a *fresh* instance per built agent (i.e. per turn) via
    :func:`build_hindsight_capability`: the recalled-memory cache below is
    per-instance, which is what makes it both safe under concurrency and cheap.

    Args:
        config: Resolved connection + tuning settings for this run.
        client: The ``Hindsight`` client to use. Always passed explicitly so the
            upstream package's own global ``configure()`` and its
            ``HINDSIGHT_API_KEY`` env fallback are never in play — there is
            exactly one resolution path, ours.
        retain_tags: Tags written onto everything this run stores.
        recall_tags: Tags a recall is filtered to; empty means the whole bank.
        read_only: An ``/ask`` turn. Drops ``hindsight_retain`` entirely, so the
            read-only guarantee holds at the toolset layer as well as in the
            builder's allowlist.
    """

    config: HindsightConfig
    client: Any
    retain_tags: tuple[str, ...] = ()
    recall_tags: tuple[str, ...] = ()
    read_only: bool = False

    _toolset: FunctionToolset | None = field(default=None, init=False, repr=False)
    _tool_names: frozenset[str] = field(default=frozenset(), init=False, repr=False)
    # The upstream recall callable, or ``None`` when injection is turned off.
    _recall_block: Any = field(default=None, init=False, repr=False)
    # The cached injection block. ``None`` means "not recalled yet, or invalidated".
    _recalled: str | None = field(default=None, init=False, repr=False)
    _recalled_at: float = field(default=0.0, init=False, repr=False)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, init=False, repr=False)

    def __post_init__(self) -> None:
        from hindsight_pydantic_ai import create_hindsight_tools, memory_instructions

        tools = create_hindsight_tools(
            bank_id=self.config.bank_id,
            client=self.client,
            budget=self.config.budget,
            max_tokens=self.config.max_tokens,
            tags=list(self.retain_tags),
            recall_tags=list(self.recall_tags),
            recall_tags_match=STRICT_TAG_MATCH,
            # An /ask turn may recall and reflect but never write.
            include_retain=not self.read_only,
            include_recall=True,
            # ``reflect`` is a server-side LLM call, so it stays switchable —
            # it matters for a self-hosted instance running a small model.
            include_reflect=self.config.include_reflect,
        )
        self._recall_block = (
            memory_instructions(
                bank_id=self.config.bank_id,
                client=self.client,
                query=self.config.recall_query,
                budget=self.config.budget,
                max_results=INJECTION_MAX_RESULTS,
                max_tokens=self.config.max_tokens,
                prefix=INJECTION_PREFIX,
                tags=list(self.recall_tags),
                tags_match=STRICT_TAG_MATCH,
            )
            if self.config.inject_memories
            else None
        )
        # Tools and injection travel together in one object: ``FunctionToolset``
        # takes both a tool list and a system-prompt callable.
        self._toolset = FunctionToolset(
            tools=tools,
            id=TOOLSET_ID,
            instructions=self._instructions if self._recall_block else None,
        )
        self._tool_names = frozenset(self._toolset.tools.keys())

    # --- capability protocol -------------------------------------------------

    def get_toolset(self) -> AbstractToolset[Any] | None:
        return self._toolset

    @property
    def tool_names(self) -> frozenset[str]:
        """Names of the tools this capability actually registered."""
        return self._tool_names

    async def before_run(self, ctx: RunContext[Any]) -> None:
        """Make sure the bank exists before the first tool call or injection."""
        await ensure_bank(self.client, self.config)

    async def after_tool_execute(
        self,
        ctx: RunContext[Any],
        *,
        call: ToolCallPart,
        tool_def: ToolDefinition,
        args: ValidatedToolArgs,
        result: Any,
    ) -> Any:
        """Bust the recall cache once the agent stores something new.

        Without this, a fact the agent just retained would be invisible to the
        injected block for the rest of the turn. Deliberately does nothing but
        clear a slot — no I/O and nothing that can raise, because exceptions from
        this hook are *not* covered by ``ToolErrorsAsText`` (see its docstring)
        and would abort the run.
        """
        if call.tool_name == RETAIN_TOOL:
            self._recalled = None
        return result

    # --- injection -----------------------------------------------------------

    async def _instructions(self, ctx: RunContext[Any]) -> str:
        """The recalled-memory block, recalled at most once per turn.

        pydantic-ai re-evaluates instruction callables on every model request, so
        the upstream callable is wrapped rather than used directly: a 150-round
        turn would otherwise issue 150 recalls, each with server-side retrieval
        cost, and would rewrite the system prompt underneath the model mid-turn.
        Caching gives one recall per turn and a system prompt that stays stable
        within it. See :data:`RECALL_CACHE_TTL` for why the entry expires at all.
        """
        assert self._recall_block is not None
        async with self._lock:
            cached = self._recalled
            if cached is not None and time.monotonic() - self._recalled_at < RECALL_CACHE_TTL:
                return cached
            # Upstream swallows its own failures and returns "" — a memory
            # service that is down must not stop the turn from starting.
            block = await self._recall_block(ctx)
            self._recalled = block
            self._recalled_at = time.monotonic()
            return block


def build_hindsight_capability(
    config: HindsightConfig,
    *,
    workspace_id: str | None = None,
    workspace_name: str | None = None,
    workspace_path: str | Path | None = None,
    agent_name: str | None = None,
    read_only: bool = False,
    client: Any | None = None,
) -> HindsightMemoryCapability:
    """Build a per-run memory capability for ``config``.

    Computes the retain/recall tags from the workspace and agent identity and
    wires them to the shared client for this connection. ``client`` is an
    injection point for tests; production always takes the cached one.
    """
    return HindsightMemoryCapability(
        config=config,
        client=client if client is not None else shared_client(config),
        retain_tags=retain_tags(
            workspace_id=workspace_id,
            workspace_name=workspace_name,
            workspace_path=workspace_path,
            agent_name=agent_name,
        ),
        recall_tags=recall_tags(
            config, workspace_id=workspace_id, workspace_path=workspace_path
        ),
        read_only=read_only,
    )
