# Lursor — Goal Mode Plan

> Status: **P1 + P2 IMPLEMENTED** (2026-07-13). Backend loop + approval gate and
> the frontend goal UI are in. P3 (mid-run steering, `report_blocked`/answer) and
> P4 (scheduling, budgets) remain. Original design below; see "Implementation
> notes" at the end for what shipped.

## 1. What we're building

A **goal mode** for Lursor threads. Today a thread is a turn-based chat: you send
a message, the deep agent runs *one* turn (internally multi-tool, but it stops as
soon as the model decides it's done), the assistant reply is persisted, the run
finishes. Goal mode adds a **self-continuing meta-loop**: you state an objective
and a completion condition, the agent **plans first and you approve the plan**,
then it works autonomously — turn after turn — until the condition is judged met,
the goal is judged impossible, a safety cap trips, or you stop it.

The differentiator vs. chat is *self-continuation*: nobody types the next
instruction. The loop recites the objective and its checklist into context each
turn (so the model doesn't drift) and re-engages the agent until "done" is real,
not just "the model paused."

### Locked decisions (from kickoff)

| Decision | Choice |
|---|---|
| Default autonomy | **Approve plan, then auto-run.** Agent plans first; user approves/edits the checklist; then the loop runs autonomously to completion. One checkpoint up front. |
| Data model | **Fields on `Thread`.** Nullable columns + lightweight `ADD COLUMN` migration. Reuses thread history as the audit log. No new table. |
| Evaluator | LLM-judged completion via the vendored engine's `GoalEvaluator`, model resolved through Lursor's provider stack (see §5). |

## 2. Key finding — the loop engine already exists (unused)

`pydantic-deepagents` (vendored as `pydantic_deep`) **already ships a complete,
provider/UI-agnostic goal-loop engine** in `pydantic_deep/goal.py`, exported from
`pydantic_deep/__init__.py`. It is modeled on Claude Code's `/goal` and is
**currently referenced nowhere** in Lursor's `backend/app` or `frontend/src`.

What it gives us (verified):

- **`GoalState`** — `condition`, `turns`, `achieved`, `last_reason`,
  `max_turns=100` (hard safety cap), `started_monotonic`, token counters.
  Properties: `.is_active` (`not achieved`), `.exhausted`
  (`not achieved and turns >= max_turns`); `.record(evaluation)` folds a result in.
- **`GoalEvaluator`** — `.evaluate(condition, messages) -> GoalEvaluation`. Judges
  from the transcript alone (no tools), constrained to a `Verdict` output type;
  **defaults to "not met" on any error** so a transient hiccup never declares
  premature success. Default model `DEFAULT_GOAL_MODEL` (a small Haiku).
- **`GoalEvaluation`** — `met`, `reason` (one sentence, fed back to the agent as
  next-turn guidance), `impossible` (genuinely unachievable this session →
  host should stop rather than grind to the cap), token counts.
- **`goal_continue_directive(condition, reason)`** — the synthetic next-turn
  prompt that re-engages the agent toward the condition.
- **`build_goal_transcript`**, **`format_goal_status`**, **`parse_goal_command`**,
  **`GOAL_CLEAR_ALIASES`**.

**Implication:** goal mode is mostly *wiring an existing engine into the existing
run loop*, not building a loop from scratch. This is the Manus/Devin pattern
(plan → execute → evaluate-against-goal → re-plan) with the evaluation step and
safety cap already implemented.

## 3. How the current run loop works (what we extend)

- **`backend/app/api/chat.py`** `chat()` → `driver()` (~L311). Persists the user
  turn up front, builds the agent via `build_deep_agent(...)`, wraps it in an
  `AGUIAdapter`, then `adapter.run_stream(deps=..., on_complete=...)` for **one
  turn**. `on_complete(result)` receives a `pydantic_ai.AgentRunResult` exposing
  `result.all_messages()` — the exact hook the goal loop needs. Assistant message
  is persisted, run marked finished. **No re-prompt loop today.**
- **`backend/app/agents/chat_run_manager.py`** — the `chat_run_manager` singleton
  owns each run as a **detached `asyncio.Task` keyed by `thread_id`**, buffers SSE
  events for replay, fans out to subscribers, survives browser disconnect, and
  supports stop/reconnect. This is already a background-job substrate; **a long
  autonomous goal run lives here unchanged.**
- **Todos** — the deep agent's `write_todos`/`read_todos` toolset mutates
  `deps.todos`; `chat.py` snapshots it and emits a `"todos"` CUSTOM AG-UI event.
  The frontend already renders it in **`ChatTodoList.tsx`**. **This is our goal
  progress board, for free.**
- **Migrations** — hand-rolled, idempotent `ADD COLUMN` blocks in
  `backend/app/db/session.py::_apply_lightweight_migrations` (PRAGMA-checked). No
  Alembic. New columns follow that exact pattern.
- **Frontend** — `useChat.ts` (`performSend` posts via AG-UI `HttpAgent.runAgent`;
  `todos`, `isStreaming`, `stop`, message queue); `workspace-chat-page.tsx` header
  controls row is where a Chat/Goal toggle lives; `agent.ts` builds the
  `HttpAgent`.

## 4. Design

### 4.1 Data model — fields on `Thread` (`db/models.py`)

All nullable / defaulted, non-breaking:

| Field | Type | Notes |
|---|---|---|
| `mode` | `"chat" \| "goal"` | default `"chat"` |
| `goal` | text | the objective (what to work on) |
| `success_criteria` | text, nullable | the completion **condition** passed to the evaluator; falls back to `goal` when empty |
| `goal_status` | enum | `pending` → `planning` → `awaiting_approval` → `running` → `completed` / `blocked` / `failed` / `stopped` |
| `iteration` | int | evaluation turns spent (mirrors `GoalState.turns`) |
| `max_iterations` | int | maps to `GoalState.max_turns` (default e.g. 25; the engine's own default is 100) |
| `require_plan_approval` | bool | default `true` (locked autonomy choice) |
| `last_reason` | text, nullable | evaluator's latest one-sentence reason (surfaced in UI) |
| `todos_snapshot` | JSON | latest checklist, persisted so progress survives reconnect (today it lives only in transient run deps) |

Migration: append `ADD COLUMN` blocks to `_apply_lightweight_migrations`.

### 4.2 Control tools (injected only in goal mode, in `builder.py`)

Structured termination beats guessing from prose. Added to the `tools` list only
when the thread runs in goal mode:

- **`report_blocked(reason, question)`** — agent cannot proceed without a human
  (missing credential, ambiguous requirement). Pauses the loop →
  `goal_status=blocked`; the question is surfaced for the user to answer.

The evaluator (`GoalEvaluator`) is the primary "done" signal, so we do **not**
strictly need a `mark_goal_complete` tool — but we may add a lightweight
`mark_goal_complete(summary)` as a fast-path that still gets validated by the
evaluator before the loop actually terminates (guards against premature
self-congratulation). Decide during P1.

### 4.3 The goal driver (extends `chat.py::driver`)

Pseudocode (streamed through `chat_run_manager` exactly as today):

```
state = GoalState(condition=success_criteria or goal, max_turns=max_iterations)
state.started_monotonic = time.monotonic()
history = existing thread messages
seed = goal            # first turn works from the objective

while True:
    result = await adapter.run_stream(seed, message_history=history, deps=deps, ...)
    history = result.all_messages()
    persist assistant turn; snapshot + persist todos

    if this was the FIRST turn and require_plan_approval:
        goal_status = awaiting_approval
        await approval_gate(thread_id)      # resolved by the approve endpoint
        # (edited checklist, if any, is already in deps.todos)

    if report_blocked fired:  goal_status = blocked; break
    eval = await evaluator.evaluate(state.condition, history)
    state.record(eval)                      # bumps turns, folds tokens
    emit goal-status CUSTOM event (iteration, met, reason)

    if state.achieved:            goal_status = completed; break
    if eval.impossible:           goal_status = blocked;   break   # needs human
    if state.exhausted:           goal_status = failed;    break   # cap hit (logged)

    seed = goal_continue_directive(state.condition, eval.reason)   # recitation
```

- **Recitation (Manus):** `goal_continue_directive` pushes the condition + the
  latest reason to the end of context each turn, countering drift on long loops.
- **No silent caps (project rule):** when `exhausted` ends the loop, emit an
  explicit event and set `failed` with the reason logged — never quietly stop.
- **Stop / reconnect:** the existing `POST /threads/{id}/stop` cancels the
  detached task (→ `stopped`); `GET /threads/{id}/stream` replays and follows.

### 4.4 Human-in-the-loop (the locked "approve plan, then auto-run" flow)

1. User sets a goal → `mode=goal`, `goal_status=planning`.
2. **Turn 1 = planning only.** Agent decomposes the objective into a `write_todos`
   checklist. `goal_status → awaiting_approval`.
3. UI shows the proposed checklist. User **approves** (optionally edits/reorders
   items, or rejects). Approval resolves the `approval_gate`.
4. Loop runs autonomously (§4.3) until `completed` / `blocked` / `failed` /
   `stopped`.
5. **Mid-run steering:** the existing message queue lets the user inject a
   course-correction; it's woven into the next `seed` alongside the directive.
6. **`blocked`:** user answers the `report_blocked` question; answer becomes the
   next seed and the loop resumes.

### 4.5 Endpoints (`api/threads.py` / `api/chat.py`)

- Reuse `POST /threads/{id}/chat` with goal params (or persisted thread fields).
- `POST /threads/{id}/goal/approve` — resolve the plan-approval gate (accepts an
  optional edited checklist).
- `POST /threads/{id}/goal/answer` — supply an answer to a `report_blocked`.
- `POST /threads/{id}/stop` — already exists.

## 5. Integration risk — the evaluator model

`DEFAULT_GOAL_MODEL` is `anthropic:claude-haiku-...`, which needs an Anthropic key.
Lursor serves models via **OpenRouter / custom (laios) providers** and may have no
Anthropic key. **The evaluator model must be resolved through Lursor's
`builder.resolve_model`** and default to something actually available — a
configurable cheap OpenRouter model, a local laios model, or (fallback) the
thread agent's own model. Config home: `AppConfig` (`deep_defaults`-style blob) or
a dedicated setting. This is the single most likely thing to break on first run —
handle it in P1.

## 6. Frontend

- **Chat/Goal toggle** in `workspace-chat-page.tsx` header controls row (next to
  the agent picker).
- **Goal setup** (composer or dialog): objective + optional success criteria +
  max iterations + "require plan approval" switch (default on).
- **Goal run view:** reuse `ChatTodoList` as the live progress board; add a goal
  banner, a `goal_status` pill, an iteration counter (`iteration / max`), and
  `last_reason`. Controls: **Stop** (exists), **Approve plan** (when
  `awaiting_approval`), **Answer** (when `blocked`), inline **steer** (existing
  queue). Consume a new goal-status CUSTOM AG-UI event in `agui/reducer.ts` /
  `types.ts` next to the existing `"todos"` handling.
- `useChat.ts` carries goal params via `HttpAgent.runAgent` forwardedProps or the
  persisted thread fields.

## 7. Build phases (each phase = runnable checkpoint)

**P1 — Backend loop.** `Thread` fields + migration; goal-mode `builder` wiring
(inject control tools, resolve evaluator model per §5); the driver loop over
`chat_run_manager`; approval gate + endpoints; caps with explicit events. Cover
with `laios-daemon`-style smoke using the existing fake adapter (no GPU/model): a
scripted fake that "achieves" after N turns exercises loop → evaluate → terminate,
plus impossible and cap paths.

**P2 — Frontend.** Chat/Goal toggle, goal setup form, goal run view (banner +
status pill + iteration counter + reused `ChatTodoList`), goal-status event
handling.

**P3 — Human-in-the-loop.** Plan approval (with checklist edit), `report_blocked`
+ answer, mid-run steering, `todos_snapshot` persistence across reconnect.

**P4 — Deferred.** Scheduled/cron goals; token/cost budget caps (engine already
counts tokens); multi-goal dashboard; a `mark_goal_complete` fast-path if P1
shows the evaluator alone is too slow/expensive per turn.

## 8. Reuse vs. net-new

- **Reuse:** `pydantic_deep.goal` engine, `chat_run_manager` (detached runs),
  `write_todos` toolset + `ChatTodoList`, `useChat` streaming, `stop` endpoint,
  the lightweight-migration pattern.
- **Net-new:** the driver meta-loop, `report_blocked` (+ optional
  `mark_goal_complete`), `Thread` goal fields, approval/answer endpoints, the
  Chat/Goal toggle + goal setup + status view, and the evaluator-model resolution.

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Goal drift on long loops | `goal_continue_directive` recitation each turn; keep error traces in context |
| Runaway loop / cost | `max_iterations` cap + `impossible` early-exit; token counters (P4 budget) |
| Premature "done" | Evaluator defaults to *not met* on error; optional `mark_goal_complete` still validated by evaluator |
| Evaluator model unavailable | Resolve through Lursor providers; configurable default (§5) — P1 gate |
| "Why a meta-loop if a turn already loops?" | A turn stops when the *model* thinks it's done; the meta-loop enforces the *stated condition* + checkpoints the single turn can't |

## Implementation notes (what shipped in P1 + P2)

Backend:
- **`backend/app/agents/goal_loop.py`** — `drive_goal_loop` (the provider-agnostic
  loop: run turn → evaluate → continue/terminate), `build_goal_evaluator`
  (resolves the evaluator model through Lursor's stack, §5), `build_continuation_adapter`
  (synthetic-directive adapter that sidesteps the request adapter's message
  re-append), the `goal_status` CUSTOM event encoder, and `goal_gates` (per-thread
  approval `asyncio.Event`s).
- **`backend/app/api/chat.py`** — the `chat()` driver now branches: `chat_driver`
  (unchanged single turn) vs. `goal_driver` (planning turn → optional approval
  gate → execution loop, streaming/persisting each turn and emitting goal-status
  events). New endpoint `POST /threads/{id}/goal/approve`. Goal progress is
  persisted via `_set_goal_state`.
- **`backend/app/db/models.py`** — `ThreadMode`/`GoalStatus` enums, goal columns on
  `Thread`, `AppConfig.goal_evaluator_model`. Migrations in `db/session.py`.
- **Tests** — `tests/test_goal_loop.py` (loop control flow) and
  `tests/test_goal_chat.py` (full driver path incl. approval gate) with a
  `TestModel` agent + fake evaluator, offline.

Frontend:
- **`src/components/chat/GoalPanel.tsx`** — `GoalSetup` (objective / criteria /
  max iterations / approve toggle) and `GoalBanner` (status pill, iteration
  counter, evaluator reason, Approve action).
- **`src/pages/chat/workspace-chat-page.tsx`** — Chat/Goal header toggle, goal
  setup on a fresh goal conversation, banner + reused `ChatTodoList` progress
  board, Stop/Approve controls.
- **AG-UI plumbing** — `goal_status` event parsed in `agui/stream-reader.ts`,
  surfaced as `goalStatus` from `agui/useChat.ts` (both send + reconnect
  transports); `approveGoal` in `api/threads.ts`; goal fields on the `Thread`
  types.

Deviations from the original design: the evaluator (`GoalEvaluator`) is the sole
"done" signal for now — the optional `mark_goal_complete` fast-path and the
`report_blocked` tool are deferred to P3. A `blocked` status is still reached via
the evaluator's `impossible` verdict.

### Plan-review redesign (2026-07-13, follow-up)

The original blocking-gate approval (one long-lived run parked on an
`asyncio.Event`) held the thread, so the user couldn't talk to the agent about
the plan. Replaced with a two-phase model that makes the plan a first-class,
editable artifact:

- **Planning is iterative chat.** Each message on a goal thread (while approval
  is on) runs a *single* planning turn that writes/revises a Markdown plan doc
  (`GOAL_PLAN.md`) at the workspace root and then ends in `awaiting_approval` —
  so the thread is free and the user can send more messages to refine the plan.
- **The plan opens in the file panel.** On entering `awaiting_approval` the
  frontend `requestOpenFile`s `GOAL_PLAN.md` so the user reads/edits alongside
  chat. (Fixes "the plan is never shown" — the plan is now a concrete file, not
  just chat prose that a given model may or may not emit.)
- **Approve starts execution.** `POST /goal/approve` now spawns a fresh detached
  execution run (the multi-turn loop, seeded from the persisted transcript +
  the plan doc). The frontend follows it via `useChat.followRun()` (GET stream).
- **Autonomy toggle preserved.** Approval off → `chat` skips the review phase and
  runs the autonomous loop directly (`AUTONOMOUS_KICKOFF`, no plan doc).
- The composer stays available during planning/review and is swapped for a Stop
  control only while the autonomous loop is executing (`goal_status == running`).

## Sources (research)

- [explainX — Goal mode for AI agents](https://explainx.ai/blog/goal-mode-ai-agents-complete-guide-2026)
- [Manus — Context Engineering for AI Agents](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) · [technical investigation](https://gist.github.com/renschni/4fbc70b31bad8dd57f3370239dccd58f)
- [How Devin thinks — planning, DAG execution, re-planning](https://medium.com/@nitinmatani22/how-devin-ai-actually-thinks-autonomous-planning-dag-execution-and-dynamic-re-planning-explained-997be175a475) · [Cognition — verifying agentic development](https://cognition.ai/blog/testing-development)
- [Oracle — The AI agent loop](https://blogs.oracle.com/developers/what-is-the-ai-agent-loop-the-core-architecture-behind-autonomous-ai-systems) · [MindStudio — Loop engineering](https://www.mindstudio.ai/blog/what-is-loop-engineering-autonomous-ai-agent-workflows)
