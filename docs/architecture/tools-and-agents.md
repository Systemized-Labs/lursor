# Tool loading, subagents, memory and the Assistant

Indexed from [`AGENTS.md`](../../AGENTS.md) §6.

## Tool loading — a small core, the rest on demand

`agents/tool_loading.py`. A fully-enabled agent offers 52 tools / ~10.7k tokens of
definitions — past the 30-50 band where tool-selection accuracy degrades. Every
tool outside `_CORE_TOOLS` is marked `defer_loading=True` and hidden until a
`search_tools` call reveals it (Anthropic's tool-search structure; pydantic-ai's
`ToolSearch` capability picks native-vs-local per model, and Lursor is always on
the local path because every model resolves to `OpenAIChatModel` /
`TolerantOpenAIChatModel`). 23 tools up front, ~5.6k tokens.

Traps, all load-bearing:

- **Anything a directive names by hand must be core.** `DEV_SERVER_DIRECTIVE`
  names `list_shells`/`run_in_background`/`kill_shell`, the memory and skills
  prompts name theirs. Hiding a tool the prompt orders the model to call is the
  same class of bug as trap 12 in `AGENTS.md` §7.
- **Guidance lives on the `search_tools` description, not in the system prompt.**
  Instructions are assembled *before* tools are prepared each step, so a
  "deferral is live" flag read at instruction time is a step stale — wrong on the
  opening step. The tool description only exists when something is deferred, so
  it cannot go stale.
- **Deferral composes with the filters, it does not bypass them.** The read-only
  allowlist and the `task` roster rewrite run per step, so they still vet a tool
  the model discovers mid-turn. `search_tools` itself is allowlisted, or `/ask`
  would strand its deferred tools.
- Threshold (`_MIN_DEFERRABLE`) means small rosters stay flat, `/ask` included;
  below it pydantic-ai registers no `search_tools` at all. `TOOL_SEARCH_ENABLED=false`
  restores the flat roster everywhere.

Full audit of the tool surface, including open findings:
[`../TOOL-SURFACE-AUDIT.md`](../TOOL-SURFACE-AUDIT.md).

## File editing

The file-editing tools (hashline read/edit) are audited separately against Claude
Code and the reference hashline implementations:
[`../FILE-EDITING-AUDIT.md`](../FILE-EDITING-AUDIT.md). The guards that audit
produced live in `agents/file_editing.py` (both ends of a range edit are
validated, `write_file` cannot clobber an unread file, an anchor miss returns
fresh anchors) and `agents/edit_syntax.py` (delta-only syntax check). Fixes that
belong in the dependency are prepared as ready-to-submit diffs under
[`../upstream/`](../upstream/), not opened as PRs.

## Subagents

No "built-in override" concept — a built-in is a name, the library's description
and instructions, and an on/off switch. Overrides could express strictly less
than an ordinary subagent row and bypassed the `enabled` check.

The `task` tool's description ships `Use "general-purpose" when no specialized
subagent fits.` unconditionally, and `subagent_type: str` has no enum — so
disabling that built-in still produced `Error: Unknown subagent
'general-purpose'`. Fixed with a `PrepareTools` capability that rewrites the
`task` tool definition from the live roster and injects an `enum`, using
`dataclasses.replace` (never in-place mutation of a schema shared across runs).
The library's post-hoc validation stays as the backstop for local models that
ignore enums.

A user subagent with the same name as a built-in **shadows** it, not the reverse.

## Memory

App-wide *provider* choice (`AppConfig.memory_provider`), exactly like web
search; the per-agent `include_memory` flag stays the master on/off switch.

- `file` (default) — pydantic-deep's `MEMORY.md` in the workspace.
- `hindsight` — a [Hindsight](https://github.com/vectorize-io/hindsight) bank via
  `agents/hindsight.py`. Optional extra (`uv sync --extra hindsight`); a missing
  package or base URL **degrades to file memory with a warning**, never fails.

The two never coexist in one run — six overlapping memory tools is worse than
three. Isolation is by tag (`workspace:{id}`, using the *id* so a rename doesn't
orphan memories) with `tags_match="any_strict"`, the only variant that excludes
untagged memories. `MEMORY.md` files are left on disk, so flipping back is
lossless.

`memory_instructions` recalls on **every model request** upstream — a 150-round
turn would issue 150 recalls. Our capability caches the recalled block per agent
instance with a 120s TTL, busted by `after_tool_execute` when the agent retains
something. Privacy changes with this provider: recall/reflect send the query
string to whatever `base_url` points at, once per turn, whether or not the agent
uses memory.

## The Assistant — the control plane

`app/assistant/`. Every other agent in Lursor is a peer: a row, a toolset, no
privileges. The Assistant is the one *place* where an agent can also operate
Lursor itself — create workspaces, retarget another agent's model, manage
schedules, start runs, read the bill.

**Entitlement attaches to the workspace, not to an agent.** Any agent you select
in the Assistant workspace gets the control-plane toolset for that run; the same
agent in one of your projects does not. The whole recognition rule is
`identity.is_assistant_workspace`, called once per build in `api/chat.py`. There
is no privileged agent row, no name to protect and no flag to keep in sync —
each of those would have been a second place for the answer to "may this run hold
the control plane?" to live. The agent seeded alongside the workspace
(`ASSISTANT_AGENT_ID`, GLM 5.2 via OpenRouter) is **ordinary**: rename it,
retarget it, delete it and use your own — none of that changes what it can do.

The workspace is app-owned the way Skill Studio is: a real row at a known
location (`ASSISTANT_WORKSPACE_ID`, a literal rather than a uuid so it is obvious
in a `sqlite3` session and cheap to compare every turn), a computed flag on the
read model, and a sidebar that files it separately from your projects. It cannot
be moved or deleted.

**The package boundary is the security boundary.** Nothing under `app/agents/`
may import from `app/assistant/` except `registry`, which is a deliberate leaf —
it imports only pydantic-ai, which is what lets `agents/builder.py` take the
guard without a cycle. That is also why `ASSISTANT_TOOL_NAMES` is a hand-written
literal rather than derived by importing `tools.py`.

- A hand-written name set can drift from the tools that exist, which is trap 15.
  Two things stop it, and neither is a subset assertion (a subset passes a dead
  entry silently): `assert_registry_matches` runs at the bottom of `tools.py`, so
  importing the toolset fails loudly on a mismatch in *either* direction, and
  `tests/test_assistant_isolation.py` compares the set against the names a real
  build registers.
- A leak **raises** (`AssistantToolLeak`) rather than filtering. Filtering would
  make a broken boundary invisible: the agent would quietly lose a tool and the
  bug would surface months later as "why can't this agent do X".
- `CONTROL_PLANE_PROMPT` lives in `registry.py` beside the name set, and
  `build_deep_agent` appends it to whichever agent receives `extra_tools` — so
  there is no build path that grants the tools without the rules. It is written
  as an *addition* to a prompt, not a persona, because the agent holding it is a
  user-editable row whose own instructions are still its own.
- Every tool is prefixed `lursor_`. The prefix makes a leak legible at a glance
  and keeps these out of the namespace of the ~50 deep-agent tools beside them.
- Only five names stay out of tool-search deferral (`ASSISTANT_CORE_TOOLS`:
  three list tools plus `create_workspace` / `update_agent`). Deferring the rest
  is what keeps 26 new tools from being a ~5k-token regression on every turn.

**Each tool is a thin wrapper over an existing route handler.** There is no
service layer in this repo, so the handlers under `app/api/` *are* the business
logic — calling `workspaces.create_workspace(payload, session)` reuses its
validation, its 400s and its system-workspace guards for free, and a rule added
to the HTTP surface applies here on the same commit. Two things every tool does
differently from an HTTP caller: it **opens its own session** (the request-scoped
one is closed the moment the response starts streaming, while the run is a
detached task that outlives it), and it **turns `HTTPException` into text**,
rendering FastAPI's 422 `detail` list into one line that names the offending
field.

**Destructive actions block on an in-chat confirmation** (`confirm.py`;
`ASSISTANT_DESTRUCTIVE_TOOLS` is the four deletes). The tool registers a pending
entry, publishes an AG-UI `CUSTOM` event named `assistant_confirm`, and `await`s
— safe precisely because a run is a detached task, so a blocked tool holds
nothing open and a client that hangs up does not cancel it. The event carries a
`sticky_key`, so it is replayed on every reconnect even after the 5000-line
buffer trims it: that is what makes "refresh the page mid-prompt" work rather
than stranding a run on a card nobody can see. The resolution goes out under the
same key, so a late reconnect sees a settled card. **Expiry is a denial, never a
default-yes** (`CONFIRM_TIMEOUT`, five minutes).
