# PLAN: Chat mode dropdown (Ask / Edit / Plan)

Status: **implemented**
Owner: chat surface
Related: [PLAN-goal-mode.md](./PLAN-goal-mode.md)

Implementation notes:
- Decided defaults: new conversation starts in **Edit**; the dropdown resets to
  the default on New conversation (ask/edit is per-turn, not persisted).
- Read-only gating is wired via a `PrepareTools` capability passed to
  `create_deep_agent` (pydantic-ai 2.8.0 exposes `prepare_tools` through the
  capabilities API).
- **Correction after testing:** the first cut used a blocklist
  (`write_file`/`edit_file`/`hashline_edit`/`execute`) and a write still got
  through — the deep-agent toolset exposes many other write paths: `task`
  (spawns a full-write subagent), `run_in_background`/`run_skill_script`
  (shell/script execution), monitors, etc. Switched to an **allowlist**
  (`_READONLY_TOOL_ALLOWLIST`): keep only read/search/skill-inspect/todo tools,
  drop everything else. Verified end-to-end with a `FunctionModel` that captures
  the tools the model is actually offered (`test_build_deep_agent_read_only_allowlists_tools`).
- The mode dropdown is a standalone `ChatModeSelect` rendered at page level
  (below the input surface) so it stays visible across the composer, goal-setup,
  and goal-execution states — not embedded in `ChatComposer`.

## Goal

Replace the header `chat` / `goal` segmented toggle with a **dropdown below the
chat input** offering three modes:

| Dropdown label | Meaning | Maps to (internal) |
|----------------|---------|--------------------|
| **Ask** | Agent answers but **cannot edit** — read-only (no `write_file`, `edit_file`, `execute`/shell). | chat thread, read-only turn |
| **Edit** | Normal chat (today's `chat` mode) — full tools. | chat thread, normal turn |
| **Plan** | Today's **goal mode**, renamed — setup → plan → approve → autonomous loop. | goal thread |

## Decisions (confirmed with user)

1. **Three modes**: Ask, Edit, Plan. Plan **is** today's goal mode, just
   relabeled and relocated into the dropdown. No new/separate "goal" mode.
2. **Ask = read-only**: remove `write_file`, `edit_file`, `hashline_edit`, and
   `execute` (shell). Reading/searching (`ls`, `read_file`, `glob`, `grep`,
   `view_image`, `web_search`) stays available.
3. **Switchable per message** — but with a nuance forced by the architecture
   (see below): Ask↔Edit switch freely per turn within a chat conversation;
   Plan is a whole lifecycle chosen when the conversation starts.

## Architecture nuance: what "per message" really means

Today `Thread.mode` (`chat` | `goal`) is fixed at thread creation and drives
driver selection in `backend/app/api/chat.py`. Ask and Edit differ **only** in
tool availability for a single turn — both are `chat` threads — so they can flip
per message cheaply by carrying the choice on the request.

Plan (goal) is stateful across turns (`planning → awaiting_approval → running`,
`goal_status`/`iteration` persisted on the thread) and drives a different set of
backend drivers. It cannot meaningfully "switch in" mid-chat. So:

- **New conversation**: dropdown offers Ask / Edit / Plan.
  - Ask or Edit → a `chat` thread. The per-turn mode rides on each send and can
    change every message.
  - Plan → a `goal` thread (existing goal machinery, relabeled). Locked to the
    goal lifecycle, exactly like today's goal mode.
- **Open chat thread**: dropdown offers Ask / Edit / **Plan**. Ask/Edit are
  per-turn. Selecting Plan shows the goal-setup form; starting it **promotes the
  current chat thread into a goal thread** (PATCH `mode=goal` + config), keeping
  its history — so Plan can be entered at any time.
- **Open goal thread**: dropdown shows Plan, locked (a goal thread's lifecycle
  can't switch back to chat).

This keeps the change small and reuses all goal machinery unchanged.

## Wire protocol: carrying the turn mode

The frontend already POSTs every turn to `POST /threads/{id}/chat` via the AG-UI
`HttpAgent`. `HttpAgent.runAgent()` accepts `forwardedProps`, which serialize
into the request body as `forwardedProps`. We pass the per-turn mode there:

```ts
// useChat.performSend
await agent.runAgent({ forwardedProps: { turn_mode: "ask" } }, { ... })
```

Backend reads it from the already-parsed body in `chat()`:

```python
turn_mode = (body.get("forwardedProps") or {}).get("turn_mode", "edit")
read_only = (thread.mode == ThreadMode.chat) and turn_mode == "ask"
```

No DB migration: Ask vs Edit is a per-request modifier, not persisted. `Thread`,
`ThreadMode`, `GoalStatus`, and all goal columns are unchanged.

## Read-only enforcement (Ask mode)

Gate at the tool layer so it's a hard guarantee, not a prompt suggestion.
pydantic-ai's `Agent` accepts a `prepare_tools` callback (a `ToolsPrepareFunc`)
that receives the tool definitions each step and returns a filtered list;
`create_deep_agent` forwards unknown kwargs to `Agent(...)`, so we can pass it
through `build_deep_agent`.

```python
# build_deep_agent(..., read_only: bool = False)
_READONLY_BLOCKLIST = {"write_file", "edit_file", "hashline_edit", "execute"}

async def _drop_mutating_tools(ctx, tool_defs):
    return [t for t in tool_defs if t.name not in _READONLY_BLOCKLIST]

if read_only:
    create_deep_agent(..., prepare_tools=_drop_mutating_tools)
```

Notes / to verify during implementation:
- Confirm the exact tool names emitted by the console toolset for the active
  `edit_format` (`hashline`): it registers `hashline_edit` vs `edit_file`. The
  blocklist covers both to be safe.
- Confirm the installed pydantic-ai version forwards `prepare_tools` (it's in
  the `Agent.__init__` signature and `create_deep_agent(**agent_kwargs)` passes
  it through). If a version mismatch surfaces, fall back to building a filtered
  console toolset (`include_filesystem=False` + a read-only `create_console_toolset`
  passed via `toolsets=`).
- Ask still needs the workspace `LocalBackend` for reads; only the mutating
  tools are removed.

## Changes by file

### Backend

1. **`app/agents/builder.py`**
   - Add `read_only: bool = False` param to `build_deep_agent`.
   - Define the blocklist + `prepare_tools` filter; pass `prepare_tools` into
     `create_deep_agent` when `read_only` (guard against a caller-supplied
     `prepare_tools` in `extra_config`).

2. **`app/api/chat.py`**
   - In `chat()`, read `turn_mode` from `body["forwardedProps"]` (the body is
     already read for the user turn around line 522; capture `forwardedProps`
     there).
   - Compute `read_only = thread.mode == ThreadMode.chat and turn_mode == "ask"`.
   - Thread `read_only` through `_build_agent_and_context(...)` →
     `build_deep_agent(...)`. (Add a `read_only` kwarg to
     `_build_agent_and_context`.)
   - `chat_driver` / goal drivers otherwise unchanged. Goal threads ignore
     `turn_mode`.

### Frontend

3. **`src/api/types.ts`**
   - Add `export type TurnMode = "ask" | "edit"` (UI dropdown also has "plan",
     but plan is expressed by creating a goal thread, not a TurnMode).

4. **`src/agui/useChat.ts`**
   - Accept the current turn mode (via options or a `send`/`performSend` arg)
     and pass `{ forwardedProps: { turn_mode } }` into `agent.runAgent(...)`.
   - `startGoal` unchanged (Plan reuses it).

5. **`src/components/chat/ChatComposer.tsx`**
   - Render a small mode dropdown **below** the textarea row (inside the
     composer card footer). Props: `mode`, `onModeChange`, `availableModes`,
     `modeLocked`. Use existing `Select` primitives; semantic text colors only
     (`text-foreground` / `text-muted-foreground`), no absolute colors.

6. **`src/pages/chat/workspace-chat-page.tsx`**
   - Remove the header `chat`/`goal` segmented control.
   - Introduce a `dropdownMode` state: `"ask" | "edit" | "plan"`.
     - `"plan"` selected on a fresh conversation → render the existing
       `GoalSetup` (unchanged path: `showGoalSetup`).
     - `"ask"`/`"edit"` → normal composer; pass the derived `TurnMode` to
       `chat.send`.
   - Availability rules:
     - Open goal thread → dropdown shows Plan, locked.
     - Open chat thread → Ask/Edit enabled, Plan disabled (hint: New
       conversation).
     - Fresh conversation → all three enabled.
   - Map the existing goal UI/labels to the "Plan" wording where user-facing
     (banner/setup copy). Internal enum values stay `chat`/`goal`.

## Out of scope

- No change to the goal loop, evaluator, approval endpoint, or persistence.
- No DB migration.
- Ask mode does not add an approval/interrupt channel — it hard-removes the
  mutating tools instead.

## Test / verify

- `chat_driver` read-only: send in Ask mode, assert the agent has no
  `write_file`/`edit_file`/`execute` (unit against `build_deep_agent(read_only=True)`;
  inspect the prepared tool list).
- Edit mode unchanged (regression): existing smoke path.
- Plan mode: existing goal smoke path still passes (planning → approve → run).
- Manual: dropdown placement/locking rules in the three thread states; dark and
  light mode contrast on the dropdown.

## Open questions

- Default mode for a brand-new conversation: **Edit** (proposed) vs Ask?
- Should the last-used mode persist per conversation in the UI (local only), or
  always reset to the default on New conversation?
