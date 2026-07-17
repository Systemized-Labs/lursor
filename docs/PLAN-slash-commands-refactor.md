# PLAN: Slash-command refactor — remove chat modes, add `/ask` `/plan` `/goal`

> Status: **IMPLEMENTED** (2026-07-17). Backend + frontend landed; `bun tsc`/`oxlint`
> clean, `uv run pytest` 61 passed. See "Implementation notes" at the end for what
> shipped and where it deviated from this design.
> Supersedes: [PLAN-chat-modes.md](./PLAN-chat-modes.md) (Ask/Edit/Plan dropdown) and
> the UX layer of [PLAN-goal-mode.md](./PLAN-goal-mode.md) (the goal *engine* below is
> kept and reused; only its entry UX changes).

## 0. Why

The UX and code grew a three-way "mode" concept that is actually **three
different things wearing one name**, and the seams show:

- `ChatMode` (`ask | edit | goal`) — a frontend-only dropdown union.
- `TurnMode` (`ask | edit`) — the per-turn modifier actually sent to the backend
  (`goal` is *not* a turn mode).
- `ThreadMode` (`chat | goal`) — the real persisted backend concept, with its own
  drivers, endpoints, and lifecycle.

Picking "goal" in the dropdown silently *promotes a thread* into a different
driver; picking "ask" sets a per-turn read-only flag; "edit" is the default. The
mapping is spread across a dropdown component, composer props, a 3-way render
branch in the page, settings, and two backends. It's hard to reason about and
harder to extend.

**Target end state:** no mode dropdown. A plain message runs the full agent. Behaviors
are opt-in via **slash commands** typed in the composer, exactly like Claude Code:

| Command | Behavior | Scope |
|---|---|---|
| *(none)* | **Full agent** — all tools (edit, shell, subagents). The default. | per-turn |
| `/ask` | **Read-only** Q&A — reads/search/web only, no writes/shell. | per-turn |
| `/plan` | **Plan mode** — read-only; agent explores and drafts a plan, presents it, waits for approval; approve → executes it. | sticky (until approved/exited) |
| `/goal <condition>` | **Autonomous loop** — works turn after turn until an evaluator judges the condition met (or impossible / cap / stopped). | sticky (whole thread lifecycle) |

## 1. Decisions (confirmed with user, 2026-07-17)

1. **Default = full agent.** A plain message (no slash) runs the normal agent
   with full tools. Slash commands are opt-in overlays. (Matches Claude Code.)
2. **Keep read-only** as `/ask` — a per-turn read-only turn, reusing today's
   `read_only` tool gating.
3. **`/plan` = propose, `/goal` = autonomous.** Two distinct commands.
   `/plan` is Claude-Code-style plan mode (read-only, present a plan, approve).
   `/goal` loops autonomously until the success condition is met. They **compose**:
   run `/plan` to agree on an approach, then `/goal` to execute it to completion.
4. **Clean break, migrate data.** Refactor the data model properly for the
   command-based design; migrate existing goal threads; drop the dead
   `TurnMode`/`ChatMode`/`require_plan_approval` plumbing rather than reskinning it.
5. **Commands must be modular / extensible.** We will add many more commands over
   time. Adding one must be a **single declarative registration** — no new
   `switch`/`if` arms scattered across the composer, page, `useChat`, and the
   backend driver. See §4.2 (the command contract). This is a primary design goal,
   not a nice-to-have.
6. **Default agent *per command*** (resolves old Q1). Each command can name a
   default agent; the registry entry carries it. (Keeps the door open for
   `/review`, `/test`, etc. each preferring a different agent.)
7. **Drop the goal approval gate** (resolves old Q2). Remove `require_plan_approval`
   and `POST /goal/approve`. Planning-first is expressed by composing `/plan` then
   `/goal`. `/goal <condition>` starts the autonomous loop immediately.

## 2. How Claude Code does this (research summary — the model we copy)

From the official docs (agent-sdk/slash-commands, permission-modes, goal, scheduled-tasks):

- **Slash commands are prompt injection + tool scoping.** Typing `/name args` in
  the composer expands a template (built-in or a markdown file under
  `.claude/commands/<name>.md` / `.claude/skills/<name>/SKILL.md`) into the turn.
  Frontmatter can set `description`, `argument-hint`, `allowed-tools` (restricts
  the tools for that run), and `model` (per-command model override). Args are
  substituted as `$ARGUMENTS` / `$0` / `$1`. Commands are *stateless*; they don't
  run as scripts, they shape the prompt and the tool set.
- **Plan mode is a permission mode enforced at the tool layer** (not a prompt
  suggestion). Writes and mutating Bash are blocked; reads/read-only Bash pass.
  Claude presents a markdown plan and waits. Approval UX is a menu ("approve +
  auto-run", "approve + manual edits", "keep planning"). Approving exits plan
  mode into an execution permission mode.
- **`/goal <condition>` is an evaluator loop.** After every turn a *fast, separate
  model* (Haiku by default) judges the transcript against the condition. Not met →
  auto-continue next turn with the evaluator's reason as guidance. Met → clear the
  goal, return control. Status line shows turns/elapsed. `/goal clear` stops it.
  Conditions must be things Claude can *demonstrate in the transcript* (e.g. "tests
  in test/auth pass"), not filesystem facts it can't surface.
- **`/loop [interval] [prompt]`** is a *separate* time-based scheduler (poll/babysit
  on a cron), distinct from `/goal`. **Out of scope** for this refactor — noted so
  we don't conflate it with `/goal`. (Lursor already has a scheduler concept in
  PLAN-daemon-lifecycle-control; `/loop` could layer on later.)

**The good news:** Lursor already implements the hard parts. The vendored
`pydantic_deep.goal` engine (`GoalState`, `GoalEvaluator`, `goal_continue_directive`)
plus `backend/app/agents/goal_loop.py` (`drive_goal_loop`) is *exactly* the
Claude-Code `/goal` loop, already wired through `chat_run_manager`, with steering,
stop, and reconnect. And `pydantic_deep.goal.parse_goal_command` is a ready-made
`/goal <condition>` / `/goal clear` parser we can adopt. This refactor is mostly
**collapsing the mode plumbing and replacing the dropdown with a slash parser** —
not rebuilding the loop.

## 3. Current architecture (what we're changing)

*(Full map in the research; the load-bearing files.)*

**Frontend**
- `src/api/types.ts:251-270,456-466` — `ChatMode`, `TurnMode`, `ThreadMode`,
  `GoalStatus`, `DefaultAgentsSettings`.
- `src/components/chat/chat-modes.ts` — `MODE_META`, `MODE_ORDER` (dropdown source).
- `src/components/chat/ChatModeSelect.tsx` — the dropdown.
- `src/components/chat/ChatComposer.tsx:76-83,320-328` — mode props + dropdown render;
  also hosts the `@`-mention typeahead (`mentions/`) we model the slash menu on.
- `src/pages/chat/workspace-chat-page.tsx` — the state owner: `chatMode` state (`:88`),
  goal/chat sync (`:130-153`), `handleModeChange`/`defaultAgentFor` (`:187-198`),
  `turnMode` mapping (`:302`), availability/lock logic (`:424-451`), the 3-way render
  branch (`:649-730`).
- `src/agui/useChat.ts:113,138-142,491-494,549-572` — `turnMode` on the queue and
  `forwardedProps.turn_mode` on send.
- `src/components/chat/GoalPanel.tsx` — `GoalSetup`, `GoalBanner`, `GoalRunPanel`.
- `src/pages/settings/default-agents-section.tsx` — per-mode default agent.
- `src/components/chat/mentions/` — **reuse target**: full textarea typeahead
  (parse-as-you-type, menu, token expansion) to base the slash menu on.

**Backend**
- `app/api/chat.py` — `turn_mode` parse (`:614-622`), `read_only` (`:653`),
  `is_goal` (`:677`), driver selection (`:757-797`), goal endpoints
  (`/goal/approve` `:821-877`, `/goal/interject` `:880-912`), `_run_goal_execution`
  (`:465-558`), `planning_driver`/`autonomous_driver`.
- `app/agents/builder.py` — `build_deep_agent(..., read_only=...)` + `_readonly_tool_filter`
  allowlist (`:143-181,516-517`); base prompt assembly (`:565-570`).
- `app/agents/goal_loop.py` — `drive_goal_loop`, phase prompts, steering, `GOAL_PLAN.md`.
- `app/db/models.py:93-118,406-422` — `ThreadMode`, `GoalStatus`, goal columns on
  `Thread`; `AppConfig.default_agents`, `goal_evaluator_model`.
- `app/schemas/{thread,settings}.py`, `app/api/settings.py` — mode-keyed schemas.
- `pydantic_deep/goal.py` — engine + `parse_goal_command` (unused today).

## 4. Target design

### 4.1 Concept model (the simplification)

Collapse the three overlapping concepts into **two orthogonal things**:

1. **Turn intent** (per message, stateless): `chat` (default, full tools) or
   `ask` (read-only). Carried on the request. This is the *only* per-turn modifier.
2. **Thread mode** (sticky, persisted): `chat` (default) · `plan` · `goal`. The
   thread's active long-running behavior. `plan` and `goal` are entered by a slash
   command and have a small status lifecycle.

`edit` disappears as a named thing — "full tools" is just the absence of `ask`.
`ChatMode` and `TurnMode` (the frontend unions) are deleted.

### 4.2 The command contract (modular by construction)

**Goal: adding a command is one declarative entry — nothing else changes.** The
composer, menu, parser, dispatch, and pill are all *generic* and driven by the
registry. No command-specific branches anywhere in the UI shell or the driver.

#### The command descriptor (single source of truth)

`src/components/chat/commands/types.ts`:

```ts
export type CommandKind =
  | "turn-intent"    // per-message modifier (e.g. /ask). Stateless.
  | "thread-mode"    // sticky mode owning the thread (e.g. /plan, /goal).
  | "action";        // fire-and-forget local action (e.g. /clear). No agent turn.

export interface SlashCommand {
  name: string;                 // "ask" — invoked as /ask
  aliases?: string[];           // ["stop"] for /goal clear|stop
  description: string;          // shown in the menu
  argumentHint?: string;        // "<condition>" — shown after the name
  kind: CommandKind;
  defaultAgent?: string;        // per-command default agent (decision 6)
  // What the command DOES — one of these, by kind:
  turnIntent?: TurnIntent;                 // kind="turn-intent" → forwardedProps.turn
  enterMode?: ThreadMode;                  // kind="thread-mode"  → PATCH mode, then send
  run?: (ctx: CommandContext) => void;     // kind="action"       → local handler
  // Optional lifecycle hooks (generic; most commands need none):
  parseArgs?: (raw: string) => Record<string, unknown>;  // e.g. --max N
}
```

A command is **data**. `/ask` is `{name:"ask", kind:"turn-intent", turnIntent:"ask"}`.
`/plan` is `{name:"plan", kind:"thread-mode", enterMode:"plan", defaultAgent:...}`.
`/goal` is `{name:"goal", kind:"thread-mode", enterMode:"goal", parseArgs:...}`.

#### The registry

`src/components/chat/commands/registry.ts` exports `COMMANDS: SlashCommand[]` and
`getCommand(name)`. This **replaces `chat-modes.ts`** as the single source of truth.
Built-in initial set: `/ask`, `/plan`, `/goal`, `/clear`. Later commands
(`/review`, `/test`, `/explain`, …) are appended here — no other file changes.

#### Generic dispatch (no per-command branching)

The composer/`useChat` dispatch is a small state machine keyed on `command.kind`,
not on the command name:

- **`turn-intent`** → send the remaining text with `forwardedProps.turn = command.turnIntent`
  and `forwardedProps.agent = command.defaultAgent` (if set).
- **`thread-mode`** → `PATCH /threads/{id}` `{mode: command.enterMode, ...parsed}`,
  then send the remaining text as the mode's first turn. Exiting a sticky mode is
  generic (PATCH `mode=chat`).
- **`action`** → call `command.run(ctx)` locally; no agent turn.
- **no command** → default: `forwardedProps.turn = "chat"`.

Because the switch is on `kind` (a closed set of ~3), the UI shell never grows when
commands are added. **What varies per command lives in the descriptor.**

#### Backend mirror (thin, also generic)

The backend does not need a full command registry — commands resolve to two
existing primitives it already understands: a **turn intent** (`forwardedProps.turn`
→ `read_only`) and a **thread mode** (`Thread.mode` → driver selection). The
frontend translates commands into these before they hit the wire, so the backend
stays a clean `chat | plan | goal` driver dispatch (§4.3, §4.4). New *turn-intent*
and *action* commands need **zero** backend change; only a genuinely new sticky
*mode* (rare) touches the driver dispatch — and that's a single new `case`.

#### Parser + menu (generic, reused from mentions)

- **Parser**: leading-`/` parser modeled on `mentions/use-mentions.ts`. It reads
  `COMMANDS` to autocomplete; it has no hard-coded command names.
- **SlashMenu** (clone of `MentionMenu`): renders `COMMANDS` filtered by the typed
  prefix, showing `description` + `argumentHint`. Adding a command makes it appear
  automatically.

#### Active-mode affordance

Instead of a dropdown, a generic **pill** in the composer reflects the active
sticky mode from `thread.mode` + the registry entry ("Plan mode · read-only" /
"Goal: <condition>") with an ✕ to exit. Per-turn commands (`/ask`) show a transient
chip until sent. The pill is data-driven — no per-command rendering. All text uses
`text-foreground`/`text-muted-foreground` only — no absolute colors.

#### Extensibility path (design now, build later)

This contract is deliberately shaped so P5 (custom user commands, Claude-Code-style
`.claude/commands/*.md`) is *loading more `SlashCommand` descriptors from markdown
frontmatter* — same registry, same generic dispatch. We do not build P5 now, but
the descriptor fields (`description`, `argumentHint`, `defaultAgent`, and a future
`allowedTools`/`model`) intentionally mirror Claude Code's frontmatter so the file
loader is additive.

### 4.3 Plan mode (`/plan`) — new, decoupled from goal

Reuses the *planning half* of today's goal machinery, extracted so it stands alone.

Lifecycle on `Thread.status`: `planning → awaiting_approval → (approve) → executing → chat`.

1. `/plan <objective>` sets `mode=plan`, `status=planning`. The turn runs
   **read-only** (`build_deep_agent(read_only=True)`) and drafts a plan into
   `PLAN.md` at the workspace root (rename `GOAL_PLAN.md` → `PLAN.md`, shared).
   Frontend opens `PLAN.md` in the file panel (existing `requestOpenFile` path).
2. Status → `awaiting_approval`. The composer stays free: further messages are
   read-only *refinement* turns (existing `REFINE_INSTRUCTION`) that revise `PLAN.md`.
3. **Approve** (a button on the plan banner, or `/approve`): `POST /threads/{id}/plan/approve`
   spawns a **full-tool execution run** seeded from the transcript + `PLAN.md`
   (existing `EXECUTION_KICKOFF`). status → `executing`. This is a *single*
   autonomous execution run (not an evaluator loop) — it implements the plan and
   finishes.
4. On finish, `mode` returns to `chat`, `status=idle`. (If the user wants
   run-until-verified instead of one-shot execution, they use `/goal` — that's the
   documented difference.)
5. **Exit without approving**: ✕ on the pill → PATCH `mode=chat`, `status=idle`.

This is Claude Code plan mode: read-only exploration → present plan → approve →
execute. Enforcement is at the tool layer (allowlist), not the prompt.

### 4.4 Goal mode (`/goal`) — reuse the engine, simplify the entry

The loop engine (`goal_loop.py` + `pydantic_deep.goal`) is **kept as-is**. Changes
are only at the entry/UX and the removal of the always-on approval gate:

- `/goal <condition>` starts the **autonomous loop immediately** — no upfront
  approval gate. (Clean break: drop `require_plan_approval` as a default-on gate.
  Planning-first is now an explicit `/plan` you run beforehand.) This matches
  Claude Code's `/goal`, which starts looping at once.
- Reuse `drive_goal_loop`, `GoalEvaluator`, `goal_continue_directive`,
  `chat_run_manager`, the `goal_status` custom events, steering (`/goal/interject`),
  and stop — all unchanged.
- `GoalRunPanel` (live progress deck) is kept. `GoalSetup` (the full objective/
  criteria/max-iters/approval form) is **removed** — the condition comes straight
  from the `/goal <condition>` argument; `max_iterations` falls back to a default
  with an optional `/goal <condition> --max N` flag or an advanced field on the
  running banner.
- `/goal` (no args) → show status pill (turns/elapsed/last reason). `/goal clear|stop`
  → stop. Powered by `parse_goal_command`.

### 4.5 Data model (clean break + migration)

`app/db/models.py`:

- `ThreadMode` → `chat | plan | goal` (add `plan`).
- Replace `GoalStatus` with a generalized `ThreadStatus`:
  `idle | planning | awaiting_approval | executing | running | completed | blocked | failed | stopped`
  (shared by plan + goal; `executing` = plan's one-shot run, `running` = goal loop).
- Keep on `Thread`: `goal` (→ rename to `objective`? optional), `success_criteria`,
  `status` (was `goal_status`), `iteration`, `max_iterations`, `last_reason`,
  `todos_snapshot`.
- **Drop** `require_plan_approval` (gate removed).
- `AppConfig.default_agents` JSON: re-key from `{ask,edit,goal}` to a
  **command-keyed** map `{ <command-name>: <agent-id> }` (decision 6). The registry
  descriptor's `defaultAgent` is the built-in default; this config overrides it per
  command. New commands slot in without a schema change (it's an open JSON map, not
  a fixed enum).

Migration (idempotent `ADD COLUMN`/`UPDATE` in `db/session.py::_apply_lightweight_migrations`,
the existing hand-rolled pattern — no Alembic):
- Add `plan` to the mode check constraint (SQLite is lax; just widen the app enum).
- `UPDATE thread SET status = goal_status` (copy), then treat `goal_status` as legacy/unused.
- Existing `mode='goal'` rows keep working (loop engine unchanged).
- Existing `chat` rows unaffected. No data loss.

### 4.6 Wire protocol

- Replace `forwardedProps.turn_mode: "ask"|"edit"` with
  `forwardedProps.turn: "chat"|"ask"` (rename for clarity; same mechanism).
- `read_only = (turn == "ask") or (thread.mode == "plan")`. Plan turns are always
  read-only; execution runs (post-approval) are full-tool.
- New endpoint `POST /threads/{id}/plan/approve` (the plan → execute transition).
- **Remove `POST /goal/approve`** and the `require_plan_approval` gate entirely
  (decision 7). Goal starts looping immediately; approval-first is `/plan` + `/goal`.

## 5. Changes by file

### Backend

1. `app/db/models.py` — widen `ThreadMode`; add `ThreadStatus`; rename `goal_status`
   → `status` usage; drop `require_plan_approval`.
2. `app/db/session.py` — migration block (copy `goal_status`→`status`, widen enums).
3. `app/api/chat.py` — parse `forwardedProps.turn`; compute `read_only` incl.
   `mode==plan`; driver selection over `chat | plan | goal`; extract a
   `plan_driver` + `_run_plan_execution` from the current planning/execution code;
   add `POST /plan/approve`; **remove `POST /goal/approve`**; delete `turn_mode="edit"`
   naming; goal entry starts the loop immediately (no approval gate).
4. `app/agents/goal_loop.py` — rename `GOAL_PLAN.md` → `PLAN.md` (shared); keep the
   loop; expose the planning/execution helpers for the plan driver to reuse.
5. `app/agents/builder.py` — unchanged `read_only` gating (already correct); no
   prompt-level mode logic needed.
6. `app/schemas/{thread,settings}.py`, `app/api/settings.py` — re-key default-agents
   to commands; drop `ChatMode`/`_CHAT_MODES`; expose `status` field.

### Frontend

7. `src/api/types.ts` — delete `ChatMode`, `TurnMode`; `ThreadMode = "chat"|"plan"|"goal"`;
   `ThreadStatus`; new `TurnIntent = "chat"|"ask"`; re-key `DefaultAgentsSettings`.
8. **Delete** `src/components/chat/chat-modes.ts` and `ChatModeSelect.tsx`.
9. **New** `src/components/chat/commands/` — `types.ts` (`SlashCommand` contract, §4.2),
   `registry.ts` (`COMMANDS` data + `getCommand`), `SlashMenu.tsx` + `use-slash.ts`
   (cloned from `mentions/`), `dispatch.ts` (generic kind-based dispatch). Adding a
   future command = one entry in `registry.ts`.
10. `src/components/chat/ChatComposer.tsx` — remove mode props + dropdown; wire the
    slash menu; render the active-mode pill.
11. `src/pages/chat/workspace-chat-page.tsx` — delete `chatMode` state, sync effect,
    `handleModeChange`, availability/lock logic; drive plan/goal via commands;
    keep the plan/goal panels branch (now keyed on `thread.mode`).
12. `src/agui/useChat.ts` — replace `turnMode` with `turn` intent on the queue +
    `forwardedProps.turn`; add plan-mode send + `approvePlan`.
13. `src/components/chat/GoalPanel.tsx` → generalize: keep `GoalRunPanel` +
    banner; add a `PlanBanner`/approve action; remove `GoalSetup`.
14. `src/pages/settings/default-agents-section.tsx` — re-key to commands (or simplify).
15. `src/api/threads.ts` — add `approvePlan`; **remove** `approveGoal`; keep
    `interjectGoal` (steering) and `stop`.

## 6. Open questions

*(Resolved: default-agent-per-command → yes, decision 6. Goal approval gate → dropped,
decision 7. Modularity → command contract, §4.2.)*

1. **Custom user commands** (Claude-Code-style `.claude/commands/*.md` with
   frontmatter + `$ARGUMENTS`): confirmed **follow-up (P5)** — the §4.2 contract is
   built so this is additive (a markdown → `SlashCommand` loader). OK to defer?
2. **`/plan` execution shape**: approve → one-shot full-tool run (proposed), or
   approve → drop back to normal chat and let the user drive execution manually?
3. Rename `Thread.goal` → `objective`, or leave as-is to minimize churn?

## 7. Build phases (each = a runnable checkpoint)

- **P0 — Data model + wire.** Widen `ThreadMode`, add `ThreadStatus`, migration,
  rename `turn_mode`→`turn`. No behavior change yet; existing goal threads still run.
  Tests: migration idempotency; `read_only` for `turn=ask` and `mode=plan`.
- **P1 — Slash dispatch (frontend).** Command registry + SlashMenu + parser + pill;
  delete the dropdown. `/ask` and default routing work end-to-end. Plan/goal
  commands PATCH+route to existing drivers.
- **P2 — Plan mode.** Extract `plan_driver`/`plan/approve` from goal code; `PLAN.md`;
  read-only enforcement; PlanBanner + approve. `/plan` → propose → approve → execute.
- **P3 — Goal entry simplification.** `/goal <condition>` immediate loop; remove
  `GoalSetup` + approval gate; `/goal` status / `/goal clear`. Keep the loop engine.
- **P4 — Settings + cleanup.** Re-key/simplify default-agents; delete dead
  `ChatMode`/`TurnMode`/`chat-modes.ts`/`ChatModeSelect.tsx`; update tests
  (`test_goal_chat.py`, `test_goal_loop.py`, `test_api.py`).
- **P5 (follow-up, optional) — Custom commands.** Markdown-file commands with
  frontmatter (`description`, `argument-hint`, `allowed-tools`, `model`) and
  `$ARGUMENTS` substitution, à la Claude Code.

## 8. Reuse vs. net-new

- **Reuse:** the whole goal loop (`goal_loop.py`, `pydantic_deep.goal`,
  `drive_goal_loop`, evaluator, steering, stop, reconnect); `chat_run_manager`;
  `read_only` tool gating; `ChatTodoList`/`GoalRunPanel`; the `mentions/` typeahead
  as the slash-menu template; `parse_goal_command` from the vendored engine; the
  lightweight-migration pattern; `requestOpenFile` for the plan doc.
- **Net-new:** the slash parser/registry/menu + active-mode pill; the standalone
  `plan_driver` + `/plan/approve` (extracted, not rebuilt); the `ThreadStatus`
  generalization + migration; wire rename.
- **Deleted:** `ChatMode`, `TurnMode`, `chat-modes.ts`, `ChatModeSelect.tsx`, the
  3-way dropdown/lock logic, `GoalSetup`, `require_plan_approval`, `POST /goal/approve`,
  mode-keyed settings.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Migration corrupts existing goal threads | Copy (not move) `goal_status`→`status`; keep goal engine untouched; idempotent PRAGMA-guarded blocks; test on a copy of `lursor.db`. |
| Slash parser vs `@`-mentions collide in the composer | Both live in one textarea — scope slash to *leading* `/` only; mentions stay inline. Reuse the mentions state machine so they share one caret model. |
| Plan/goal share `PLAN.md` and clobber each other | Only one sticky mode active per thread at a time (mode is exclusive); `/plan` and `/goal` can't both own the thread simultaneously. |
| Read-only leak in plan mode (the historical bug) | Keep the **allowlist** approach already proven in PLAN-chat-modes (`_readonly_tool_filter`), not a blocklist. Reuse verbatim. |
| Scope creep into custom commands / `/loop` | Explicitly deferred (P5 / out of scope). |

## Implementation notes (what shipped, 2026-07-17)

Landed across backend + frontend; `bunx tsc` and `oxlint` clean, `uv run pytest`
61 passed.

**Backend**
- `db/models.py` — `ThreadMode` widened to `chat | plan | goal`; `GoalStatus`
  renamed to `ThreadStatus`; `Thread.goal_status`→`status`; `require_plan_approval`
  removed; `default_agents` re-documented as command-keyed.
- `db/session.py` — migration adds `status` (copying legacy `goal_status`), drops
  the `goal_status`/`require_plan_approval` DDL.
- `api/chat.py` — wire flag `turn_mode`→`turn` (`chat`|`ask`); driver dispatch over
  `chat`/`plan`/`goal`; `plan_driver` (was `planning_driver`); `goal_driver` now the
  sole goal path (immediate loop, no gate); new `_run_plan_execution` (single
  full-tool turn); `POST /goal/approve` replaced by `POST /plan/approve` (returns the
  thread to `chat`/`idle` then executes); `_set_goal_state`→`_set_thread_state`.
- `agents/goal_loop.py` — `GOAL_PLAN.md`→`PLAN.md`; plan-mode instruction wording;
  `ThreadStatus` throughout. Loop engine, evaluator, steering, stop unchanged.
- `schemas/{thread,settings}.py`, `api/settings.py`, `api/threads.py` — `status`
  field; command-keyed default-agents (`chat/ask/plan/goal`); dropped
  `require_plan_approval`.

**Frontend**
- New modular command system in `src/components/chat/commands/`: `types.ts`
  (`SlashCommand` contract), `registry.ts` (`COMMANDS` + `parseSlashCommand` +
  `matchCommandPrefix`), `use-slash.ts`, `SlashMenu.tsx`. Adding a command = one
  registry entry.
- `ChatComposer` — slash menu + `ModePill` (exit control) replace the dropdown.
- `workspace-chat-page` — `chatMode` state/dropdown removed; `handleSend` dispatches
  on `command.kind`; `enterMode`/`handleExitMode`/`handleApprovePlan`; `RunBanner`
  drives plan approval; opens `PLAN.md` on review.
- `GoalPanel` — `GoalSetup` removed; `GoalBanner`→`RunBanner`; `GoalRunPanel` kept.
- `useChat` — `turnMode`→`turnIntent`; `startGoal`→`startMode`.
- `api/types.ts` — `ChatMode`/`TurnMode` deleted; `ThreadMode` widened;
  `GoalStatus`→`RunStatus`; `goal_status`→`status`; `require_plan_approval` dropped;
  `DefaultAgentsSettings` re-keyed. `threads.ts` `approveGoal`→`approvePlan`.
- `default-agents-section` re-keyed to commands. Deleted `chat-modes.ts` +
  `ChatModeSelect.tsx`.

**Deviations from the design above**
- **Plan mode is instruction-gated, not tool-gated.** §4.3/§4.6 proposed making plan
  turns read-only. But the shipped plan turn writes `PLAN.md` (reusing the existing,
  nicer file-panel plan-review UX), which a read-only allowlist would block. So the
  planning turn keeps full tools and is *instructed* to only read/search + write
  `PLAN.md`. `read_only` therefore applies to `/ask` turns only. (True read-only
  planning à la Claude Code — plan-in-chat, no file — remains an option if desired.)
- **Wire event + agui type names kept.** The AG-UI CUSTOM event stays `goal_status`
  and the frontend `agui/types.ts` names (`AgentGoalStatus`, `GoalRunStatus`,
  `parseGoalStatus`) are unchanged for stream compatibility, even though they now
  carry plan statuses too.
- **No `executing` status.** Plan approval returns the thread to `chat`/`idle` and
  streams a normal run, so the extra `executing` status from §4.5 wasn't needed.
- **`/goal` starts immediately with no upfront plan step** (as designed); `/goal`
  status / `/goal clear` sub-commands were not added — a running goal is stopped via
  the run deck's Stop button. Easy to add later as registry entries.
- **P5 (custom `.claude/commands/*.md`) deferred** as planned; the registry contract
  is shaped so a markdown loader is additive.

### Follow-up: approve flow removed (2026-07-17)

The plan-mode Approve button + `POST /plan/approve` + `_run_plan_execution`
(single execution run) were removed as redundant ceremony. Plan mode stays a
sticky, iterative planning mode (read-oriented; drafts/refines `PLAN.md`), but
execution is now **explicit through chat**: the user exits plan mode via the
composer pill's ✕ (mode→chat) and asks the agent to carry the plan out as a
normal full-tool turn (the transcript + `PLAN.md` give it the plan). `RunBanner`
lost its approve action; `frontend approvePlan` and `useChat.followRun` were
deleted; the plan smoke tests now assert the exit-to-execute flow.

### Follow-up: `/goal` is now one-off (2026-07-17)

Only `/plan` is a persistent (sticky) mode. `/ask` and `/goal` are one-off
per-turn intents: `TurnIntent = "chat" | "ask" | "goal"`, and `/goal` is a
`turn-intent` command (not `thread-mode`). Sending `/goal <condition>` kicks off
the autonomous loop for that submission with the message as the objective; the
thread stays a plain `chat` thread (no `mode="goal"`, no pill). Backend keys the
goal driver on `turn == "goal"` (condition = the message text), never persisting
a goal mode; the goal run deck is gated on the live `goalStatus.running` rather
than `thread.mode`; interject gates on an active run rather than mode. Legacy
`mode="goal"` threads still load (enum kept) but behave as chat.
