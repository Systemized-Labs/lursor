# PLAN: The Assistant — a top-level control-plane agent

## Context

Every agent in Lursor today is a peer: a DB row scoped to one workspace, holding
the same deep-agent toolset (files, shell, skills, subagents, web). There is no
agent that can operate *Lursor itself* — create a workspace, retarget another
agent's model, schedule a nightly job, read the usage bill.

That capability already exists, but only for an **external** caller:
`integrations/hermes/` is a stdlib HTTP plugin giving a third-party assistant 17
Lursor tools. It proves the control plane is drivable, and it proves the gaps —
no workspace creation, no agent editing, no settings access.

This plan brings that agent inside. **The Assistant** is a single, app-owned,
non-project agent reachable from a global overlay anywhere in the app. It holds
the normal deep-agent toolset *plus* a control-plane toolset that no other agent
can ever obtain.

Four decisions were taken up front:

| Decision | Choice |
| --- | --- |
| UI surface | A pinned sidebar row beside the Skill Studio, backed by a real workspace |
| Default model | GLM 5.2 via OpenRouter, overridable in Settings |
| Isolation | Separate registry **plus** a runtime assertion in the normal build path |
| Destructive ops | Read and create run freely; delete/rotate blocks on an in-chat confirmation |

The isolation requirement is the load-bearing constraint and shapes everything
below: `build_deep_agent` must remain incapable of producing an agent that holds
a control-plane tool, and that must be enforced by code, not convention.

---

## What this is not

| Looks like a gap | Actually correct |
| --- | --- |
| The Assistant is not a user-editable `Agent` in the Agents list | It is app-owned. Its instructions are a code constant so a stray prompt edit cannot disarm the safety language around destructive tools. Only its *model* is user-settable. |
| It still gets an `Agent` row and a `Workspace` row | `Thread.workspace_id` and `Thread.agent_id` are both non-null FKs (`db/models.py:797-798`). Seeding two system rows is far cheaper than making a core FK nullable, and the Skill Studio already establishes the "system row, computed flag, hidden in UI" pattern (`api/workspaces.py:156`). |
| We do not duplicate the chat turn machinery | `chat.py` is 1910 lines of persistence, SSE fan-out, reconnect, compaction and usage accounting that is entirely agent-agnostic. The Assistant reuses all of it and diverges at exactly one branch point. |
| Control-plane tools call route handlers, not raw SQL | Route handlers *are* the business logic in this repo — there is no service layer (`app/service.py` is the daemon installer, not a service). Calling `workspaces.create_workspace(payload, session)` reuses its validation, its 400s and its side effects for free. |
| We are not wiring the `Tool` DB registry | Still inert by design (`AGENTS.md:1280`, audit finding 2.3b). Out of scope. |

---

## Approach

### Phase 1 — The isolation boundary (`backend/app/assistant/`)

A new package. Nothing under `app/agents/` may import from it; it imports from
`app/agents/` and `app/api/` freely.

**New files**

```
backend/app/assistant/__init__.py     # re-exports the 4 public names, nothing else
backend/app/assistant/identity.py     # constants, seeding, is_assistant_agent()
backend/app/assistant/registry.py     # ASSISTANT_TOOL_NAMES, AssistantToolGuard
backend/app/assistant/tools.py        # the control-plane tools
backend/app/assistant/confirm.py      # pending-confirmation registry
backend/app/assistant/builder.py      # build_assistant_agent()
backend/app/assistant/prompt.py       # the system prompt constant
```

`identity.py`:

```python
ASSISTANT_AGENT_NAME = "Assistant"
ASSISTANT_WORKSPACE_NAME = "Assistant"
DEFAULT_ASSISTANT_MODEL = "openrouter:z-ai/glm-5.2"

def assistant_dir() -> Path:            # settings.data_dir / "assistant"
def is_assistant_workspace(ws) -> bool  # path == assistant_dir()
def is_assistant_agent(row) -> bool     # row.name == ASSISTANT_AGENT_NAME and row.id == seeded id
async def ensure_assistant_records(session) -> tuple[Workspace, Agent]
```

`ensure_assistant_records` mirrors `ensure_skills_workspace`
(`api/workspaces.py:161`) exactly: idempotent, adopts an existing matching row
rather than adding a second, called once per boot. It gives the Assistant a real
directory so its normal filesystem/shell tools have somewhere to work — notes,
scratch scripts, exported reports.

Identity is keyed on a **stable literal id** (`id="lursor-assistant"`,
`"lursor-assistant-ws"`) passed to the constructor, overriding
`TimestampMixin`'s uuid factory. `is_assistant_agent` compares the id, not the
name, so renaming cannot smuggle privileges onto a user agent.

### Phase 2 — The control-plane toolset

`tools.py` defines plain async functions registered as pydantic-ai function
tools. Each is a thin wrapper: build the Pydantic schema, call the existing route
handler with the injected session, return a compact text/JSON summary.

One shared helper converts `HTTPException` into readable tool text, reusing
Hermes' `_format_detail` idea (`integrations/hermes/lursor/client.py:88`) so a
422 names the offending field rather than dumping a `loc/msg/type` list.

| Group | Tools | Backing handler |
| --- | --- | --- |
| Workspaces | `list_workspaces`, `create_workspace`, `update_workspace`, **`delete_workspace`** | `api/workspaces.py:193,204,236,270` |
| Agents | `list_agents`, `create_agent`, `update_agent`, **`delete_agent`** | `api/agents.py:45,51,97,116` |
| Schedules | `list_schedules`, `create_schedule`, `update_schedule`, `run_schedule_now`, **`delete_schedule`** | `api/schedules.py:115,128,178,228,203` |
| Conversations | `list_threads`, `read_thread`, `delegate`, `run_status`, `stop_run`, **`delete_thread`** | `api/threads.py`, `api/chat.py:1134,1761` |
| Config | `get_settings`, `update_settings`, `list_models`, `list_providers` | `api/settings.py`, `api/models.py:60`, `api/providers.py:103` |
| Inventory | `list_skills`, `list_subagents`, `usage_report` | `api/skills.py:618`, `api/subagents.py:138`, `api/analytics.py:105` |

Bold = destructive, gated by Phase 3.

Rules baked into the tools:

- **Secrets are never returned.** `get_settings` reuses `_hint()`
  (`api/settings.py:120`) so keys render as `…ab12`.
- `create_schedule` calls `POST /schedules/preview` before `POST /schedules`, so
  a bad cron yields a readable error and no half-made row — copied from
  `integrations/hermes/lursor/tools.py:778`.
- `update_agent` is the "edit another agent's model" path: `AgentUpdate` +
  `exclude_unset=True` means omitted fields stay untouched (`api/agents.py:104`).
- Every destructive tool reads the target first so the confirmation card and the
  result line can name what was affected.
- `update_settings` exposes an explicit allowlist of keys (compaction, web
  search, memory provider, default agents, media). Provider API keys are
  writable but never readable.
- The Assistant may not delete or retarget itself, its workspace, or the Skill
  Studio — guarded in the tool, returning a plain refusal.

`registry.py` owns the boundary:

```python
ASSISTANT_TOOL_NAMES: frozenset[str]      # every name in tools.py
ASSISTANT_CORE_TOOLS: frozenset[str]      # the ~8 kept out of tool-search deferral

@dataclass
class AssistantToolGuard(AbstractCapability[Any]):
    """Raises if a control-plane tool reaches an agent that must not have one."""
```

`ASSISTANT_TOOL_NAMES` is asserted in tests to equal the set of names actually
registered by a real build — a stale entry in a name-keyed set is exactly trap
15 (`AGENTS.md:1112ff`, audit finding 2.1), and a subset assertion hides it.

### Phase 3 — Confirmation for destructive actions

There is no approval mechanism anywhere in the codebase today, so this is new.
It fits the existing architecture because runs are **detached tasks** that own
their own lifetime (`agents/chat_run_manager.py:34`) — the HTTP response is only
a subscriber, so a tool can block without anything timing out.

`confirm.py`:

```python
CONFIRM_TIMEOUT = 300  # seconds; expiry is a denial

@dataclass
class PendingConfirmation:
    token: str; thread_id: str; summary: str; impact: str
    event: asyncio.Event; approved: bool = False

class Confirmations:
    async def request(self, thread_id, *, summary, impact) -> bool
    def resolve(self, token, *, approved) -> bool
    def pending(self, thread_id) -> list[dict]

confirmations = Confirmations()
```

`request()` publishes an AG-UI `CUSTOM` event named `assistant_confirm` through
`chat_run_manager.publish(thread_id, ...)` — the same mechanism the todo panel
uses (`api/chat.py:186-210`) — then awaits the event.

Publishing through `chat_run_manager` puts the frame in the replay buffer, so a
client that reconnects mid-prompt re-renders the card. **Both transports must
handle the new event name** — that is the standing rule for stream events here,
and it is satisfied by handling it in the shared `ChatEventHandlers` sink rather
than in either transport. `GET /api/assistant/confirmations` covers the case
where the 5000-line buffer rolled past the card.

Timeout returns `False`; the tool returns `"Not confirmed — nothing was
changed."` and the model continues.

### Phase 4 — The single branch point

`build_deep_agent` gains one keyword-only parameter and one assertion:

```python
def build_deep_agent(..., extra_tools: list | None = None, ...):
    ...
    tools = list(extra_config.pop("tools", []) or [])
    tools.append(make_view_image_tool(workspace_path))
    ...
    tools.extend(extra_tools or [])
    _assert_no_assistant_tools(tools, allowed=extra_tools is not None)
    capabilities.append(AssistantToolGuard(allowed=extra_tools is not None))
```

Two layers, deliberately:

1. **Build-time assert** — catches a control-plane tool reaching a normal build.
2. **`AssistantToolGuard`**, a `PrepareTools`-style capability running *every
   step* — catches one revealed later by tool search, or inherited through a
   toolset we did not construct. Same reasoning as `_readonly_tool_filter`
   (`agents/builder.py:527`), which is re-run per step for exactly this reason.

Critically, `_subagent_config` (`agents/builder.py:845`) recurses into
`build_deep_agent` **without** threading `extra_tools`, so a subagent the
Assistant delegates to gets zero control-plane tools and trips the guard if it
somehow does. This is the single most important test in the suite.

`assistant/builder.py`:

```python
async def build_assistant_context(session, agent_row, workspace) -> tuple[...]:
    """Same 5-tuple as _build_agent_and_context, with the control plane attached."""
```

It resolves the model as `app_config.assistant_model or DEFAULT_ASSISTANT_MODEL`,
composes `ASSISTANT_PROMPT` (code constant, not `row.instructions`), and calls
`build_deep_agent(..., extra_tools=build_assistant_tools(session))`.

`api/chat.py:822`, `_build_agent_and_context`, gets one branch at the top:

```python
if is_assistant_agent(agent_row):
    return await build_assistant_context(session, agent_row, workspace)
```

Everything downstream — SSE, persistence, `/stop`, reconnect, compaction, usage,
titling — is untouched. `POST /threads/{id}/chat` remains the only chat entry
point.

Two model notes:
- **Do not force `tool_choice: required`.** GLM 5.2 is the named motivating case
  for `openai_supports_tool_choice_required=False`
  (`agents/tolerant_model.py:14`). The Assistant pins `ToolChoice.auto`.
- The OpenRouter slug `z-ai/glm-5.2` must be verified against `GET /api/models`
  during implementation. If absent, fall back to a `CustomProvider` row pointed
  at `https://api.z.ai/api/paas/v4` — `_FAMILY_PROFILES`
  (`agents/tolerant_model.py:76`) already maps the `glm`/`zai` prefixes to
  `ZaiProvider.model_profile`, so that path needs no new code.

Tool budget: the audit measured tool definitions at 7× the system prompt, and 26
new tools would be an unacceptable regression. `build_tool_loading_capabilities`
gains an `extra_core: frozenset[str] = frozenset()` parameter; the Assistant
passes `ASSISTANT_CORE_TOOLS` (list/create workspace, list/update agent, list
schedules, delegate, get settings). The other ~18 stay behind `search_tools`,
which is what that machinery is for (`agents/tool_loading.py:203`).

### Phase 5 — Settings and routes

**`AppConfig.assistant_model: str | None`** — `db/models.py`, beside
`goal_evaluator_model:683` and `compaction_model:689`, with the additive
`ALTER TABLE` block in `db/session.py:276` (no Alembic).

`api/settings.py` gains `GET/PUT /api/settings/assistant`, following
`get_compaction_defaults`/`set_compaction_defaults` (`api/settings.py:547,586`),
plus `AssistantSettingsRead/Update` in `schemas/settings.py`. The read returns
the effective model and the default so the UI can show what an empty value
inherits.

**New `backend/app/api/assistant.py`**, prefix `/assistant`, added to the
`include_router` loop in `main.py:248`:

| Route | Purpose |
| --- | --- |
| `GET /assistant/thread` | Get-or-create the current conversation |
| `POST /assistant/threads` | Start a fresh one |
| `GET /assistant/threads` | History |
| `GET /assistant/confirmations` | Pending cards (buffer-roll recovery) |
| `POST /assistant/confirm/{token}` | `{approved: bool}` |

`ensure_assistant_records(session)` is called in the `main.py` lifespan directly
after `workspaces.ensure_skills_workspace()` (`main.py:118`).

**Hiding the system rows.** `WorkspaceRead` gains a computed `is_assistant`
alongside `is_system` (`schemas/workspace.py:46`); `AgentRead` gains the same.
`DELETE`/`PATCH` on either returns 400 for path/name changes, matching the Skill
Studio guards (`api/workspaces.py:256,274`).

### Phase 6 — The pinned sidebar row

The Assistant is surfaced exactly the way the Skill Studio is: an app-owned row
pinned below the projects tree, behind the same divider, backed by a real
workspace. That shape is what makes its **past conversations free** — they list
inline under its row and reopen in the chat pane like any other workspace's,
with no bespoke history API, no second thread list, and no state to keep in sync.

A modal was the first attempt and was wrong for exactly that reason: it needed
its own `/assistant/thread` endpoints to find the conversation to show, and a
"New" button to start another, and it still had nowhere to *list* the old ones.

**New**

- `frontend/src/components/assistant/use-assistant-hotkey.ts` — ⌘⇧A, which
  navigates to the Assistant's workspace. No open/closed state: opening it is a
  route change, which is the whole point.
- `frontend/src/components/chat/AssistantConfirmCard.tsx` — approve/deny card
  with the impact line, rendered directly above the composer where the blocked
  run's attention already is.
- `frontend/src/api/assistant.ts` — just `useConfirmAction`. Everything else the
  Assistant needs is already served by `useThreads` / `useWorkspaces`.
- `frontend/src/pages/settings/assistant-section.tsx` — `<ModelPicker>` bound to
  `assistant_model`, in the existing **model** settings category.

**Modified**

- `hooks/use-all-threads.ts` — expose `assistant` alongside `studio`, and drop
  both out of `workspaces` (the projects you made).
- `components/layout/sessions/projects-section.tsx` — the pinned block becomes
  two rows behind one divider. Drilling resolves either.
- `components/layout/sessions/project-row.tsx` — no Delete item for an app-owned
  row; the server refuses it with a 400, so the item could only ever toast.
- `components/layout/use-workspace-icons.ts` — a fixed `lightning` default so
  the Assistant reads the same in every install (still overridable).
- `pages/chat/workspace-chat-page.tsx` — pin the Assistant agent, hide the agent
  picker, its own empty state, and render the confirmation cards.
- `api/agents.ts` — `useAgents` filters the Assistant out of every picker;
  `useAssistantAgent` is the one deliberate way back to it.
- `agui/stream-reader.ts` + `agui/chatStore.ts` — handle `assistant_confirm` in
  the shared handler sink, so live-send and reconnect both get it from one
  implementation.
- `components/layout/app-shell.tsx` — bind the hotkey once.
- `lib/shortcuts.ts` — document ⌘⇧A.

---

## Ordering and stopping points

Phases 1–2 land together (a toolset nothing calls yet, plus its tests). Phase 4
is the moment the Assistant becomes reachable. Phase 3 must land **before**
Phase 4 or the destructive tools ship unguarded — alternatively land Phase 4
with destructive tools omitted from `build_assistant_tools`, and add them with
Phase 3.

If only three phases land: **1, 4 and 6** give a working read/create Assistant
with no delete tools, which is coherent and shippable.

---

## Files

**New (backend)** — `app/assistant/{__init__,identity,registry,tools,confirm,builder,prompt}.py`, `app/api/assistant.py`

**New (frontend)** — `components/assistant/{assistant-overlay.tsx,use-assistant-overlay.ts}`, `components/chat/AssistantConfirmCard.tsx`, `api/assistant.ts`, `pages/settings/assistant-section.tsx`

**New (tests)** — `tests/test_assistant_isolation.py`, `test_assistant_tools.py`, `test_assistant_confirm.py`, `test_assistant_settings.py`

**Modified (backend)** — `app/agents/builder.py` (`extra_tools` param, build assert, guard capability), `app/agents/tool_loading.py` (`extra_core` param), `app/api/chat.py:822` (one branch), `app/api/settings.py`, `app/api/workspaces.py` + `app/api/agents.py` (system-row guards), `app/db/models.py` (`assistant_model`), `app/db/session.py:276` (migration), `app/schemas/{agent,workspace,settings}.py`, `app/main.py:118,248`

**Modified (frontend)** — `components/layout/app-shell.tsx`, `components/layout/sessions/{sessions-pane,projects-section}.tsx`, `agui/{stream-reader,chatStore}.ts`, `hooks/use-all-threads.ts`, `components/settings/settings-categories.tsx`, `pages/settings/default-agents-section.tsx`, `pages/schedules/schedules-page.tsx`, `api/types.ts`

---

## Verification

**Automated**

```bash
cd backend && uv run pytest                    # must be green WITHOUT editing existing tests
cd backend && uv run ruff check app tests
cd frontend && bun run build                   # tsc -b
cd frontend && bun run lint                    # oxlint
```

The isolation tests are the point of the exercise:

1. Build a normal agent with every flag on plus browser QA; assert
   `ASSISTANT_TOOL_NAMES ∩ registered names == ∅`. Capture the roster via
   `FunctionModel`, the method the tool-surface audit used.
2. Build the Assistant; assert every name in `ASSISTANT_TOOL_NAMES` is actually
   registered — no dead entries (trap 15).
3. Delegate from the Assistant to a subagent; assert the subagent's roster is
   control-plane-free.
4. Inject a fake control-plane-named tool into a normal build's `extra_config`;
   assert `AssistantToolGuard` raises.
5. Run the Assistant with `search_tools` on; assert deferred control-plane tools
   are revealed to it and still absent from a normal agent after a search.
6. `_readonly_tool_filter` and the guard compose: an assistant `/ask` turn keeps
   only read-safe control-plane tools.

Confirmation tests: `request()` publishes the CUSTOM event; `resolve(approved=True)`
returns True and the delete lands; `resolve(approved=False)` leaves the row
intact; timeout denies. Assert the frame is present in the `chat_run_manager`
buffer so a reconnect replays it.

Migration test against a **copy** of a populated DB, per the house rule.

**Manual, end to end**

1. Boot; confirm exactly one Assistant workspace and one Assistant agent exist,
   and that re-booting adds no second pair.
2. Neither appears in the sidebar project tree, the agent picker, the
   default-agents settings, or the schedule target list.
3. The Assistant is a pinned sidebar row below the projects, above the Skill
   Studio, behind one shared divider. Its past conversations list inline under
   it and reopen in the chat pane. ⌘⇧A jumps to it from a workspace chat, the
   analytics pane and the settings dialog.
4. "Create a workspace called Scratch in ~/tmp" → row appears in the sidebar
   without a reload.
5. "Set the Builder agent's model to Claude Sonnet 4" → verify via
   `GET /api/agents`.
6. "Schedule a daily 9am standup summary in Scratch" → appears on the schedules
   page with the right next-fire time.
7. "Delete the Scratch workspace" → confirmation card renders; **Deny** leaves
   it; ask again and **Approve** removes it. Confirm the directory is still on
   disk (delete never removes it — `api/workspaces.py:280`).
8. Trigger a delete, hard-refresh mid-prompt, confirm the card re-renders from
   the replay buffer, then approve.
9. Ask for the OpenRouter key; confirm only a `…ab12` hint comes back.
10. Settings → Model → Assistant: switch off GLM and back; confirm the next turn
    uses the new model (check `GET /api/analytics/usage-by-model`).
11. Viewport pass at 390px and 1700px; dark and light.
12. `bun run build` and compare the entry chunk against a stashed baseline.

---

## Open questions

- ~~OpenRouter's exact GLM 5.2 slug.~~ Resolved: `z-ai/glm-5.2` is real,
  verified against OpenRouter's live catalogue. No fallback provider needed.
- Whether the Assistant should be a schedule target (a nightly "summarise
  yesterday's runs and email me" job). Cheap to add later; excluded from v1 so
  that unattended runs cannot hit the confirmation path with nobody watching.

## On completion

Fold into `AGENTS.md`: a new §6 subsystem "The Assistant" covering the two
system rows, the single branch point in `_build_agent_and_context`, and the
confirmation protocol; a new numbered invariant — *control-plane tools reach an
agent only through `build_deep_agent(extra_tools=...)`, and `AssistantToolGuard`
re-checks every step*; and a note in §9 that the Assistant is deliberately not
schedulable. Then delete this file.
