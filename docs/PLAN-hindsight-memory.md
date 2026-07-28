# PLAN: Bring-your-own memory layer — Hindsight as a memory provider

> Status: **IMPLEMENTED** (2026-07-28). Phases 2–4 shipped as written; see §13 for
> what was decided differently and what is still unverified.

## 0. Why

Today an agent's "memory" is a markdown file. `include_memory` on an `Agent` /
`Subagent` row (`backend/app/db/models.py:358`, `:408`) is forwarded straight to
`create_deep_agent(include_memory=...)` (`backend/app/agents/builder.py:960`),
which wires pydantic-deep's `AgentMemoryToolset`: three tools
(`read_memory` / `write_memory` / `update_memory`) over a single
`/.deep/memory/main/MEMORY.md` inside the workspace's `LocalBackend`, plus
recency-truncated injection of that file into the system prompt
(`pydantic_deep/features/memory/{toolset,service}.py`).

That is a good default and it costs nothing. It is also the whole story, and it
has three limits:

1. **It is a flat file with no retrieval.** Injection keeps the last
   `max_lines=200` lines above a pin marker; recall is "the model reads the whole
   file". Past a few hundred lines the useful fact is the one that got truncated.
2. **It is trapped in one workspace.** `MEMORY.md` lives under the workspace
   root, so what an agent learned about the user in workspace A is invisible in
   workspace B. There is no notion of memory that follows the *person*.
3. **It cannot be shared with anything else.** Users increasingly run a real
   memory service (their own, or a hosted one) that their other tools —
   Claude Code, Cursor, an assistant, a bot — already read and write. Lursor
   can't see it, and nothing else can see Lursor's `MEMORY.md`.

This plan adds a second memory provider: **[Hindsight](https://github.com/vectorize-io/hindsight)**
(MIT, by Vectorize) — an agent-memory service with `retain` / `recall` /
`reflect` over tag-scoped *memory banks*, self-hostable via Docker (API on
`:8888`, UI on `:9999`) or hosted at `https://api.hindsight.vectorize.io`. It
does entity extraction, temporal anchoring, hybrid retrieval and reflection
server-side, and it publishes a first-party Pydantic AI integration — so the
work here is wiring and configuration, not memory engineering.

The framing is deliberate: this is **bring your own memory layer**. The user
points Lursor at a Hindsight instance they already own and already populate from
elsewhere; Lursor becomes one more reader and writer of that bank, not the owner
of it.

## 1. Decisions (confirmed with user, 2026-07-28)

1. **One shared bank, tag-scoped.** A single `bank_id` for the whole app
   (default `lursor`). Isolation comes from Hindsight tags — `workspace:{id}`,
   `agent:{slug}` — applied on `retain` and used as a recall filter. Chosen over
   a bank per workspace so cross-workspace memory is possible by configuration
   rather than by migration, and so an existing bank the user already fills from
   other tools is usable as-is.
2. **Memory is an app-wide *provider* choice, exactly like web search.**
   `AppConfig.memory_provider` is `"file"` (default, today's behaviour) or
   `"hindsight"`. The per-agent `include_memory` toggle stays the master on/off
   switch and needs no UI change. This mirrors
   `AppConfig.web_search_provider` (`backend/app/db/models.py:501-507`,
   `backend/app/agents/web_search.py`), which already separates *may this agent
   search* from *which backend*.
3. **Tools only — no automatic capture.** The agent decides when to `retain`;
   recalled context is auto-injected into the system prompt each turn. Nothing is
   sent to Hindsight unless the model calls a tool or a turn starts. Auto-retain
   of transcripts (Hindsight's stated strength) is explicitly deferred — see §11.
4. **Use the official `hindsight-pydantic-ai` package**, wrapped in our own
   `AbstractCapability`, the same shape as `BrowserQACapability` and our
   `WebSearch` / `WebFetch` wiring in `builder.py:844-915`.
5. **The two providers do not coexist in one run.** When `hindsight` is
   selected, `create_deep_agent` is called with `include_memory=False` and the
   Hindsight capability is attached instead. Six memory tools with overlapping
   semantics is worse than three. `MEMORY.md` files are left on disk untouched,
   so flipping back is instant and lossless.
6. **Degrade, never fail.** A misconfigured provider (no base URL) falls back to
   file memory with a logged warning — the `web_search.py` precedent. A *reachable
   but failing* service degrades at the tool layer: tool errors come back to the
   model as text via the existing `ToolErrorsAsText` capability
   (`backend/app/agents/tool_errors.py`), and failed prompt injection returns an
   empty string (the upstream package already swallows it).

## 2. Upstream facts this plan relies on (verified 2026-07-28)

Checked against PyPI and `vectorize-io/hindsight@main`, not from memory:

| Fact | Value |
| --- | --- |
| `hindsight-client` | 0.8.5, `requires_python >=3.10`, deps `aiohttp`, `aiohttp-retry`, `pydantic>=2`, `python-dateutil`, `typing-extensions`, `urllib3` |
| `hindsight-pydantic-ai` | 0.4.20, deps `hindsight-client>=0.4.0`, `pydantic-ai-slim>=1.0.0` |
| Client construction | `Hindsight(base_url, api_key=None, timeout=300.0, user_agent=None)` |
| Lifecycle | `await client.aclose()`; also a sync `close()` and `__enter__/__exit__` |
| Health probe | `await client.aget_version() -> VersionResponse` |
| Core async ops | `aretain(bank_id, content, tags=..., metadata=..., retain_async=...)`, `arecall(bank_id, query, budget, max_tokens, tags, tags_match, types, ...)`, `areflect(bank_id, query, budget)` |
| Bank ops | `acreate_bank(...)`, bank stats/get via `client.banks` |
| `tags_match` values | `any` \| `all` \| `any_strict` \| `all_strict` \| `exact`. **`any`/`all` include untagged memories; the `_strict` variants exclude them** — so `any_strict` is the hard partition we want. Tag filtering is a SQL-level filter applied *before* ranking. |
| Integration API | `create_hindsight_tools(*, bank_id, client=None, budget="mid", max_tokens=4096, tags=None, recall_tags=None, recall_tags_match="any", include_retain=True, include_recall=True, include_reflect=True) -> list[Tool]` |
| Integration API | `memory_instructions(*, bank_id, client=None, query=..., budget="low", max_results=5, max_tokens=4096, prefix=..., tags=None, tags_match="any") -> Callable[[RunContext], Awaitable[str]]` |
| Tool names produced | `hindsight_retain`, `hindsight_recall`, `hindsight_reflect` |
| Tool failure mode | raises `HindsightError` (so our `ToolErrorsAsText` net is what keeps a turn alive) |
| Injection failure mode | returns `""` silently |

### Two upstream behaviours we must work around

**(a) `memory_instructions` recalls on every model request.** pydantic-ai
re-evaluates instruction callables per request, so a 150-round turn
(`TURN_REQUEST_LIMIT`, `builder.py:243`) would issue up to 150 `recall` HTTP
calls, each with server-side retrieval cost. Unacceptable. Our capability caches
the recalled block per agent instance with a short TTL and busts it when the
agent retains something new (§4c).

**(b) The tools construct their own client from global config when none is
passed.** We always pass an explicit client, so `configure()` and the
`HINDSIGHT_API_KEY` env var that the package reads on its own are never in play —
one resolution path, ours.

**Open item for Phase 1:** whether a bank is auto-created on first `retain`, and
what `recall` against a missing bank returns, is not documented. Phase 1 verifies
this against a local container and adds a best-effort `ensure_bank` if needed
(§4e).

## 3. Data model

All app-wide, on the existing single `AppConfig` row
(`backend/app/db/models.py:489-534`). No new tables.

```python
class AppConfig(TimestampMixin, table=True):
    ...
    # Which memory backend an agent with include_memory=True gets:
    # "file" (pydantic-deep MEMORY.md, the default) or "hindsight".
    memory_provider: str | None = None

    # Hindsight connection. base_url may be the hosted API or a self-hosted
    # instance (Docker exposes the API on :8888). Key is plaintext, like every
    # other secret this app holds; never returned by the API.
    hindsight_base_url: str | None = None
    hindsight_api_key: str | None = None

    # Tuning knobs, JSON so new ones need no migration (mirrors deep_defaults):
    #   bank_id: str = "lursor"
    #   isolation: "workspace" | "shared" = "workspace"
    #   budget: "low" | "mid" | "high" = "mid"
    #   max_tokens: int = 4096
    #   inject_memories: bool = True
    #   include_reflect: bool = True
    #   recall_query: str = ""          # blank => the default probe query
    #   extra_recall_tags: list[str] = []
    hindsight_config: dict = Field(default_factory=dict, sa_column=Column(JSON))
```

Environment fallbacks in `backend/app/config.py`, following the
`tavily_api_key` / `exa_api_key` precedent (a UI-saved value wins over env):

```python
hindsight_base_url: str | None = None   # HINDSIGHT_BASE_URL
hindsight_api_key: str | None = None    # HINDSIGHT_API_KEY
hindsight_bank_id: str = "lursor"       # HINDSIGHT_BANK_ID
```

### Migration

`backend/app/db/session.py` already does additive `ALTER TABLE` on boot guarded
by a column probe (`:205-215` for the web-search columns). Four entries go in the
existing `app_config_additions` dict:

```python
"memory_provider":     "ALTER TABLE app_config ADD COLUMN memory_provider VARCHAR",
"hindsight_base_url":  "ALTER TABLE app_config ADD COLUMN hindsight_base_url VARCHAR",
"hindsight_api_key":   "ALTER TABLE app_config ADD COLUMN hindsight_api_key VARCHAR",
"hindsight_config":    "ALTER TABLE app_config ADD COLUMN hindsight_config JSON DEFAULT '{}'",
```

`NULL` `memory_provider` means `file`, so every existing install upgrades to
exactly its current behaviour. No backfill.

## 4. Runtime wiring

### 4a. New module: `backend/app/agents/hindsight.py`

Sits alongside `web_search.py` / `web_fetch.py` / `browser_qa.py` and owns
everything Hindsight: config resolution, the shared client, tag computation, and
the capability.

```python
DEFAULT_MEMORY_PROVIDER = "file"
MEMORY_PROVIDERS = ("file", "hindsight")
DEFAULT_BANK_ID = "lursor"
DEFAULT_RECALL_QUERY = "relevant context for the current task and this user"

@dataclass(frozen=True)
class HindsightConfig:
    """Resolved, run-ready Hindsight settings. Built once per turn."""
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

def resolve_hindsight_config(
    app_config: AppConfig | None, settings: Settings
) -> HindsightConfig | None:
    """None when the provider is not 'hindsight', or when it is unusable."""
```

`resolve_hindsight_config` returns `None` (with a `logger.warning` in the second
case) when `memory_provider != "hindsight"`, or when no base URL resolves from
either the DB row or the environment. `None` means "the file provider", so the
degradation path is a single branch at the call site.

### 4b. Threading it into the builder

`build_deep_agent` already has ten-plus keyword arguments; four more would be
noise. Pass the resolved dataclass instead — the same pattern as
`skill_runtime: SkillRuntime | None`:

```python
def build_deep_agent(
    row, workspace_path, ...,
    skill_runtime: SkillRuntime | None = None,
    hindsight: HindsightConfig | None = None,   # new; None => file memory
    _subagent_depth: int = 0,
): ...
```

`chat.py:834-853` resolves it once per turn next to the existing
`web_search_provider` / key plumbing and passes it down;
`_subagent_config` (`builder.py:587-647`) forwards it into the child closure
unchanged, so a subagent shares the parent's bank and connection — same
workspace, same memory.

Inside `build_deep_agent`, replacing the single line at `:960`:

```python
# Memory. `include_memory` is the per-agent master switch; the app-wide
# provider decides where memory lives. For "hindsight" we suppress the
# library's MEMORY.md toolset and attach our own capability instead, so the
# model is never offered two overlapping sets of memory tools.
use_hindsight = row.include_memory and hindsight is not None
if use_hindsight:
    capabilities.append(
        build_hindsight_capability(
            hindsight,
            workspace_id=workspace_id,
            workspace_name=workspace_name,
            workspace_path=workspace_path,
            agent_name=row.name,
            read_only=read_only,
        )
    )
    instructions = f"{instructions}\n\n{HINDSIGHT_MEMORY_DIRECTIVE}"

library_memory = row.include_memory and not use_hindsight
```

and `include_memory=library_memory` in the `create_deep_agent` call. Both paths
respect `extra_config`, which continues to win (`builder.py:818-833`).

`workspace_id` is `None` for subagents and for the handful of callers without
one; the workspace tag then falls back to the resolved workspace path's basename,
which is stable for our workspaces (each is a directory named by its id).

### 4c. The capability

```python
@dataclass
class HindsightMemoryCapability(AbstractCapability[DeepAgentDeps]):
    """Long-term memory backed by a Hindsight bank.

    One instance per built agent (i.e. per turn), which is what makes the
    recall cache below safe and cheap.
    """
```

- `get_toolset()` returns a single
  `FunctionToolset(tools=create_hindsight_tools(...), id="hindsight-memory",
  instructions=<cached recall callable>)`. `FunctionToolset.__init__` accepts both
  `Tool` instances and an `instructions` system-prompt callable
  (`pydantic_ai/toolsets/function.py:60-77`), so tools and injection travel
  together in one object.
- `include_retain=not read_only` — an `/ask` turn can recall and reflect but
  never write. Belt and braces with §4d.
- `include_reflect=cfg.include_reflect` — `reflect` is a server-side LLM call;
  leaving it switchable matters for self-hosted instances on small models.
- **The recall cache.** `memory_instructions(...)` is wrapped: the first call per
  instance performs the recall and stores the rendered block; subsequent calls
  return the stored string until a TTL (`120s`, so a long goal-mode run that
  reuses one agent across iterations — `chat.py:955-983` — does refresh) or an
  invalidation. Result: one recall per turn instead of one per model round, and a
  system prompt that stays stable *within* a round-trip sequence.
- `after_tool_execute` (`pydantic_ai/capabilities/abstract.py:659`) clears the
  cache when `call.tool_name == "hindsight_retain"`, so a fact the agent just
  stored is visible to the next injection. The hook does nothing but clear a
  slot — no I/O, no raising, since exceptions from this hook are *not* covered by
  `ToolErrorsAsText` (see its docstring).

### 4d. Read-only (`/ask`) mode

`_READONLY_TOOL_ALLOWLIST` (`builder.py:409-435`) is an allowlist, so the new
tools are excluded by default — including the two that are genuinely read-only.
Add exactly those two:

```python
        # long-term memory: read paths only — `hindsight_retain` writes
        "hindsight_recall",
        "hindsight_reflect",
```

### 4e. Client lifecycle and bank bootstrap

One `Hindsight` per `(base_url, api_key)`, cached module-level and created
lazily so it is built inside the running event loop — the same rationale as
`_shared_openrouter_http_client` (`builder.py:356-398`). `timeout=30.0`, not the
client default of `300.0`, and `user_agent="lursor/<version>"`.

`await client.aclose()` for every cached client on FastAPI shutdown, added after
the `yield` in the `main.py` lifespan (`backend/app/main.py:43-64`) — the
underlying transport is `aiohttp`, which complains loudly about unclosed
sessions.

Bank bootstrap: a `_ensured_banks: set[str]` guard so the first use per process
best-effort ensures the bank exists (`acreate_bank`, treating an
already-exists response as success) and never blocks the turn on failure.
**Phase 1 verifies whether this is needed at all** — if `retain` auto-creates,
this collapses to nothing and gets dropped.

### 4f. Tags — how isolation actually works

Applied on every `retain`:

| Tag | Purpose |
| --- | --- |
| `lursor` | Provenance. Lets the user (or another tool) tell Lursor's memories apart in Hindsight's UI. |
| `workspace:{workspace_id}` | The scope filter. Uses the **id**, not the name, so a workspace rename doesn't orphan its memories. |
| `workspace-name:{slug}` | Human-readable label only. Never filtered on. |
| `agent:{slug(agent_name)}` | Attribution, for browsing and for future per-agent filtering. |

Recall filter, by `isolation`:

- **`workspace`** (default) — `tags=[f"workspace:{id}", *extra_recall_tags]`,
  `tags_match="any_strict"`. A hard SQL-level partition: only memories carrying
  one of those tags come back, and untagged memories are excluded. `extra_recall_tags`
  is the deliberate escape hatch — tag something `shared` in Hindsight's own UI
  (or from another tool) and add `shared` here, and it crosses workspaces.
- **`shared`** — no tag filter at all. The whole bank is in scope for every
  workspace. This is the "I already have a memory bank, read all of it" mode, and
  it is what makes an externally-populated bank work with zero setup.

Retain tags are unconditional in both modes, so switching isolation later is a
settings change, not a data migration.

### 4g. The prompt

The tools are named and described differently from `read_memory`/`write_memory`,
so agents whose instructions were written against `MEMORY.md` need a nudge. A
`HINDSIGHT_MEMORY_DIRECTIVE` in the style of `DEV_SERVER_DIRECTIVE`
(`builder.py:72-87`), appended only when Hindsight is active:

```
# Long-term memory
- You have persistent memory that outlives this conversation, stored in a
  shared memory service rather than a file in the workspace. Relevant memories
  are recalled into your context automatically at the start of each turn.
- `hindsight_recall` searches it for facts; `hindsight_reflect` asks it a
  question and gets a synthesized answer. Prefer recall for lookups and
  reflect when you need a judgement about what you know.
- `hindsight_retain` saves something new. Retain durable facts — user
  preferences, project conventions, decisions and their rationale, a solved
  recurring problem. Do not retain transient state, secrets, credentials, or
  file contents you can simply re-read.
- Memory is shared with the user's other tools. Write for a reader who does not
  have this conversation in front of them.
```

`agents/prompt_author.py:85-86` describes the memory capability as "persistent
memory (recall facts across runs)" when authoring instructions for a new agent —
still accurate for both providers, so it stays as is.

### 4h. What is deliberately untouched

- **The goal evaluator** (`build_goal_evaluator`) is a separate judging agent and
  gets no memory tools, as today.
- **`/compact`** (`agents/compaction.py`) is unrelated to memory.
- **Existing `MEMORY.md` files** stay on disk. Nothing migrates, nothing deletes;
  switching providers is reversible.

## 5. Privacy — stated plainly, because it changes

With the file provider, memory never leaves the machine. With Hindsight it goes
to whatever `base_url` points at, which may be a third-party host. Specifically:

- `retain` sends whatever the model chose to store.
- `recall` / `reflect` send the query string — including the auto-injection probe
  query, once per turn, whether or not the agent uses memory.

Injected env-var values are already redacted out of shell output before it
reaches a transcript (`agents/deduping_backend.py`), but that is not a guarantee
about `retain`: the model could store something it read from a file. So:

- The settings UI states the destination and shows a plain warning when
  `base_url` is not localhost.
- The `HINDSIGHT_MEMORY_DIRECTIVE` tells the agent not to retain secrets.
- The API never returns the stored key (hint only, `_hint()` in
  `api/settings.py:69-70`).

No content filtering or scrubbing on the retain path is proposed here. Worth
doing if auto-capture lands (§11); overkill for model-initiated writes.

## 6. API surface — `backend/app/api/settings.py`

Three endpoints, following the web-search section (`:152-202`) — including its
`model_fields_set` partial-update convention, so provider, URL, key and knobs
save independently.

```
GET    /settings/memory        -> MemorySettingsRead
PUT    /settings/memory        -> MemorySettingsRead   (partial)
POST   /settings/memory/test   -> MemoryTestResult     (does not save)
```

New schemas in `backend/app/schemas/settings.py`:

```python
MemoryProvider = Literal["file", "hindsight"]
MemoryIsolation = Literal["workspace", "shared"]
RecallBudget = Literal["low", "mid", "high"]

class MemorySettingsRead(BaseModel):
    provider: MemoryProvider
    hindsight_base_url: str | None = None
    hindsight_configured: bool = False          # a key is in effect
    hindsight_key_hint: str | None = None       # "…a1b2"
    hindsight_source: Literal["database", "env", "none"] = "none"
    bank_id: str
    isolation: MemoryIsolation
    budget: RecallBudget
    max_tokens: int
    inject_memories: bool
    include_reflect: bool
    extra_recall_tags: list[str] = []

class MemorySettingsUpdate(BaseModel):
    provider: MemoryProvider | None = None
    hindsight_base_url: str | None = None
    hindsight_api_key: str | None = None        # blank clears -> reverts to env
    bank_id: str | None = None
    isolation: MemoryIsolation | None = None
    budget: RecallBudget | None = None
    max_tokens: int | None = None
    inject_memories: bool | None = None
    include_reflect: bool | None = None
    extra_recall_tags: list[str] | None = None

class MemoryTestResult(BaseModel):
    status: Literal["ok", "error"]
    version: str | None = None       # from aget_version()
    bank_exists: bool | None = None
    memory_count: int | None = None  # bank stats, when available
    error: str | None = None
```

`POST /settings/memory/test` probes with the submitted-but-unsaved values —
`aget_version()`, then bank stats — and maps the failure modes to readable
errors (unreachable / rejected key / bank missing), the same shape as
`test_openrouter` (`:108-138`). It closes its throwaway client.

Unlike the OpenRouter key, nothing needs pushing into the running process:
the provider is read per turn at agent-build time, so a save takes effect on the
next message.

## 7. Frontend

New `frontend/src/pages/settings/memory-section.tsx`, added as a fourth entry in
`PROVIDER_TABS` (`pages/settings/providers-section.tsx:5-9`) and dispatched in
`ProvidersSection` — the same tab that already hosts Web search, which is the
closest existing analogue.

Layout: a provider radio (File / Hindsight), and — when Hindsight is selected —
connection fields (base URL with the hosted default prefilled, API key as a
password input showing only a hint once saved, **Test connection**), then bank ID,
isolation, recall budget, max tokens, and switches for "inject memories into
every turn" and "enable reflect". A short explainer that this replaces
`MEMORY.md` for every agent with memory enabled, and the localhost warning
from §5.

Also:
- `frontend/src/api/types.ts` — `MemorySettings`, `MemorySettingsInput`,
  `MemoryTestResult`, plus the three literal unions.
- `frontend/src/api/settings.ts` — `settingsApi.getMemory/setMemory/testMemory`,
  `settingsKeys.memory`, `useMemorySettings()`, `useSaveMemorySettings()`,
  `useTestMemorySettings()` (same shape as the web-search hooks).
- `pages/agents/agent-form-dialog.tsx:64-72` and the subagent equivalent:
  relabel `include_memory` from "Include memory" to "Memory", with helper text
  that names the active provider ("stored in this workspace's `MEMORY.md`" /
  "stored in Hindsight bank `<id>`"), read from `useMemorySettings()`. The
  toggle's meaning and wire field do not change.

Per the repo UI rules: every text element gets `text-foreground` /
`text-muted-foreground`, no absolute colours, and the section copies the existing
sections' spacing rather than introducing `container`.

## 8. Dependencies

`backend/pyproject.toml`, as an **optional extra** rather than a base dependency:

```toml
[project.optional-dependencies]
hindsight = ["hindsight-pydantic-ai>=0.4.20"]
```

which pulls `hindsight-client>=0.4.0` and therefore `aiohttp` +
`aiohttp-retry` — a transport this backend does not otherwise use. Keeping it
optional means the desktop bundle and anyone on the file provider pays nothing.
`resolve_hindsight_config` therefore does an import probe and degrades to the
file provider with a clear log line and a UI-visible error when the extra is
missing, exactly as `web_search.py:86-119` handles a missing `tavily-python`.

Install for development is `uv sync --extra dev --extra hindsight`. If we later
decide the packaging story is simpler with it always installed, that is a
one-line change; starting optional is the reversible direction.

Frontend: no new dependencies.

## 9. Tests — `backend/tests/`

All against a fake client (a stub exposing `aretain`/`arecall`/`areflect`/
`aget_version`), so the suite stays offline. New `test_hindsight_memory.py`:

**Config resolution**
- provider unset / `"file"` → `resolve_hindsight_config` is `None`.
- provider `"hindsight"` with no base URL anywhere → `None` + warning logged.
- DB base URL and key win over the environment; clearing the DB key reverts to env.
- `hindsight_config` defaults fill in for absent keys; a partial blob is honoured.

**Tag computation**
- retain tags contain `lursor`, `workspace:{id}`, `workspace-name:{slug}`,
  `agent:{slug}`.
- `isolation="workspace"` → recall `tags=["workspace:{id}"]`,
  `tags_match="any_strict"`; `extra_recall_tags` are appended.
- `isolation="shared"` → no recall tag filter.
- a workspace rename does not change the filter tag (id-keyed).

**Builder wiring** (assert on the built agent's toolsets, as
`test_subagent_defaults.py` and `test_env_runtime_wiring.py` do)
- `include_memory=True` + hindsight → a `hindsight-memory` toolset with the
  expected tools and **no** `deep-memory` toolset.
- `include_memory=True` + file (or no config) → `deep-memory` present, no
  Hindsight toolset. Unchanged from today.
- `include_memory=False` → neither, regardless of provider.
- `read_only=True` → `hindsight_retain` absent; recall/reflect present and in the
  allowlist.
- `include_reflect=False` → two tools.
- a subagent built through `_subagent_config` inherits the same bank and client.

**Caching**
- N instruction evaluations in one run → exactly one `arecall`.
- `after_tool_execute` for `hindsight_retain` → the next evaluation recalls again.
- an `arecall` that raises → empty injection, no exception out of the run.

**Degradation**
- a raising `aretain` surfaces as `"Error: ..."` text through `ToolErrorsAsText`
  and does not end the turn (the pattern in `test_tool_error_resilience.py`).

**API + migration**
- `PUT` then `GET /settings/memory` round-trips every field; the key is never
  echoed, only `configured` + `hint` + `source`.
- partial `PUT` leaves untouched fields alone.
- `test_memory_migration.py`, in the style of
  `test_skill_assignment_migration.py`: an `app_config` table without the four
  columns gains them on boot, and an existing row reads back as the `file`
  provider.

## 10. Phasing

Each phase is independently reviewable; nothing before Phase 4 is user-visible.

1. **Verify upstream against a real instance.** Run the container
   (`docker run -p 8888:8888 -p 9999:9999 ghcr.io/vectorize-io/hindsight:latest`),
   confirm bank auto-creation, `recall` on a missing bank, `any_strict` semantics,
   and observed latency for `recall` at each budget. Findings recorded in §12 —
   they decide whether §4e survives and whether `budget` should default to `low`.
2. **Backend core.** Dependency extra, `AppConfig` columns + migration, `config.py`
   fallbacks, `agents/hindsight.py` (config, client cache, tags, capability),
   builder + subagent threading, allowlist entry, prompt directive, lifespan
   shutdown. Tests from §9 except the API ones.
3. **API.** Schemas, three endpoints, tests.
4. **Frontend.** Types, hooks, `memory-section.tsx`, tab entry, agent/subagent
   toggle helper text.
5. **End-to-end verification** on an isolated instance against a local Hindsight
   container: retain a preference in workspace A; confirm it is recalled in a new
   thread in A and *not* in workspace B under `workspace` isolation; flip to
   `shared` and confirm it crosses; confirm `/ask` cannot retain; confirm one
   `recall` per turn in the Hindsight request log; stop the container mid-turn and
   confirm the turn survives with an error-as-text; flip back to `file` and
   confirm the old `MEMORY.md` is intact and in use. Then `uv run pytest`,
   `bunx tsc --noEmit`, `bun run build`, `ruff` on changed files.

## 11. Out of scope (and why)

- **Auto-retain of transcripts.** The highest-value follow-up and the thing
  Hindsight is actually built for — it extracts facts server-side, so it beats
  hoping the model calls `retain`. Held back because it sends every turn to an
  external service by default, and because it wants a redaction pass on the
  retain path first. Should land as an explicit, off-by-default switch.
- **Per-workspace or per-agent bank overrides.** The tag scheme covers the
  isolation need; multi-bank adds bootstrap and UI for a case nobody has yet.
- **Mental models, directives, entities, documents, files.** Hindsight has a
  much larger surface (~27 MCP tools). Three tools is the right first cut;
  mental models are the most interesting next candidate.
- **Hindsight's MCP endpoint** (`/mcp/{bank_id}/`) as the transport. Zero Python
  deps, but it would put ~27 tools in the prompt and needs a connection per bank.
  Rejected in favour of the typed integration.
- **Reflect as the goal-mode evaluator.** Interesting, unrelated.
- **Migrating existing `MEMORY.md` content into a bank.** A one-shot "import this
  file into Hindsight" action is easy to add later; doing it automatically on a
  provider switch would be surprising and hard to undo.

## 12. Open questions

1. **Bank auto-creation** — resolved in Phase 1; decides whether §4e ships.
2. **Default recall budget.** `mid` per the upstream default, but injection runs
   once per turn on the critical path before the first model call. If Phase 1
   shows `mid` costs more than ~300ms, default `inject_memories` to `low` and say
   so in the UI.
3. **Default `recall_query`.** The upstream default is
   `"relevant context about the user"`, which biases toward user facts over
   project facts. §4a proposes
   `"relevant context for the current task and this user"`. Better still would be
   using the actual user message as the query — but instructions callables do not
   cleanly see it, and it would defeat the per-turn cache. Left configurable.
4. **`workspace-name:{slug}` tag** — a nicety for browsing Hindsight's UI. Drop
   it if it turns out to pollute the tag index.

## 13. As-built notes (2026-07-28)

Everything in §§2–9 was verified against the installed packages before wiring, and
the plan's upstream facts all held. What differs from the plan:

- **Phase 1 (live container) was not run** — no Docker daemon available on this
  machine. Two consequences:
  - **§4e survives, but inverted.** Rather than a `retain`-auto-creates bet,
    `ensure_bank` *lists* banks and creates only a genuinely absent one. Bank
    creation is a `PUT` that doubles as an update, and the premise here is that
    the bank may be one the user already owns and configured elsewhere — so we
    never write to an existing bank. One extra request, once per process per bank.
  - **§12.2 (default budget) is unresolved.** `mid` shipped, per the upstream
    default, and the UI says a deeper setting makes every turn start slower. No
    latency measurement was possible.
- **§4a knob resolution is one shared function**, `hindsight.resolve_knobs`, used
  by both `resolve_hindsight_config` and `GET /settings/memory`, so the values the
  settings page reports cannot drift from the values a turn applies.
- **Two extra fields on the API** beyond §6: `hindsight_installed` (so a selected
  provider with the extra missing is visible in the UI rather than only in a log
  line) and `recall_query` (already a documented knob in §3, just absent from the
  §6 schema).
- **§7's provider radio is a select**, matching the web-search section it sits
  next to rather than introducing a new control for the same kind of choice.

Verified beyond the §9 suite:

- The real `hindsight_client` against a stub HTTP server: correct URLs, `Bearer`
  auth, `lursor/<version>` user-agent, retain tags, `any_strict` recall filter,
  bank creation on a missing bank, no write on an existing one, and 20 instruction
  evaluations producing zero extra recalls.
- A real agent turn: the recalled memory and the directive both reach the model's
  `instructions` (pinned as a test — asserting on message *parts* passes
  vacuously, since capability instructions do not live there).
- `POST /settings/memory/test` against the **actual hosted API**
  (`api.hindsight.vectorize.io`): reported `Connected to Hindsight 0.8.4`, and the
  unauthenticated bank listing degraded to "could not read the bank list" while
  still reporting the connection as OK — the intended split.
- A live boot on a pre-memory database: the four columns are added, the existing
  row reads back as the `file` provider, and shutdown drains the aiohttp clients
  with no unclosed-session warnings.

**Phase 5 end-to-end against a real Hindsight container remains outstanding** —
specifically the cross-workspace isolation flip and the mid-turn service kill.
