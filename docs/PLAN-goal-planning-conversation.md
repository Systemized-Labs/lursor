# Lursor — Goal Mode: Planning Conversation Upgrade

> Status: **IMPLEMENTED** (2026-07-16). See "Implementation notes" at the end.
>
> Original plan below, retained for context.
> Scope decided with the user (2026-07-16):
> - **Real planning conversation** — a distinct pre-approval phase where you chat
>   with the agent, it revises `GOAL_PLAN.md` across turns with full context, and
>   nothing executes until you approve.
> - **Composer stays in planning mode** — messages sent before approval only
>   revise the plan and reply conversationally; they never kick off execution.
>   Approve is the only way to start work.
> - **Keep `GOAL_PLAN.md`** — stay with the flat on-disk markdown artifact the
>   agent rewrites. No new plan data model.
>
> Follow-up decisions (2026-07-16, resolves §7):
> - **After a goal terminates**, a new message starts a **fresh planning round**
>   for the same thread (re-enter planning, require Approve again).
> - **Plan-updated signal**: a **lightweight banner indicator** + refresh the open
>   file. No diff view.
> - **Approve is the only gate** — refinement can never skip straight to execution.
> - **Prompt wording**: go with the drafted copy; tweak during the PR.

## 1. Goal of this upgrade

Turn the pre-approval step from a one-shot "here is the plan, approve it" into a
genuine **planning conversation**: the user and agent go back and forth — "add a
migration step", "we don't need X", "how would you handle auth?" — the agent
revises `GOAL_PLAN.md` and replies conversationally each turn, and **only an
explicit Approve** transitions the thread into the autonomous execution loop.

## 2. What already exists (baseline)

The "Plan-review redesign" (see `PLAN-goal-mode.md`, bottom) already shipped the
skeleton of this:

- A goal thread with `require_plan_approval=true` runs `planning_driver`
  (`backend/app/api/chat.py:689`): one planning turn writes/revises `GOAL_PLAN.md`
  (`PLAN_DOC`, `goal_loop.py:52`) then sets `GoalStatus.awaiting_approval` and ends,
  leaving the thread free.
- The composer stays available during `awaiting_approval`; sending another message
  re-runs `planning_driver` (dispatch at `chat.py:730-733`).
- `POST /threads/{id}/goal/approve` (`chat.py:790`) spawns a fresh detached
  execution run (`EXECUTION_KICKOFF`) seeded from the persisted transcript +
  the plan doc; the frontend follows via `chat.followRun()`.
- The frontend auto-opens `GOAL_PLAN.md` in the file panel on entering
  `awaiting_approval` (`workspace-chat-page.tsx:397-413`) and renders `GoalBanner`
  with the Approve button (`GoalPanel.tsx:216-288`).

**So the plumbing is there.** The gaps are that it behaves like a side-effect, not
a designed conversation.

## 3. Gaps to close

1. **One-shot prompt reused for every turn.** Both the first plan and every
   refinement run the same `PLANNING_INSTRUCTION` (`goal_loop.py:57-68`), which
   reads "Write a clear, step-by-step implementation plan … to the file
   `GOAL_PLAN.md`". On a follow-up the agent has to *infer* from the transcript
   that it should read the existing file and revise it rather than regenerate.
   No explicit "the user is giving feedback on your draft" framing.

2. **Dispatch keys off the wrong signal.** `chat()` routes to `planning_driver`
   purely on `is_goal && require_plan_approval` (`chat.py:732`), ignoring
   `goal_status`. Consequences:
   - A message sent *after* a goal completes/stops re-plans instead of doing
     anything sensible (latent bug).
   - There's no phase concept to hang "first plan vs refine" or UI state on.

3. **No conversational framing in the UI.** During `awaiting_approval` the banner
   shows a status pill + Approve. Nothing tells the user "this is a draft — chat
   to refine it, or Approve to run." The composer placeholder is the generic chat
   one, so refining feels undiscoverable.

4. **Refinement context robustness.** Planning turns run with
   `message_history=None` and lean on the AG-UI request carrying the transcript
   from the browser (`chat.py:704`). This is fine mid-session but fragile on
   reconnect / fresh load. Execution already seeds history from the DB
   (`messages_to_history`); planning should do the same for parity.

## 4. Design

### 4.1 Backend — a `planning` phase, two instructions

Introduce an explicit planning phase driven by `goal_status`, not by the approval
boolean.

- **Add `REFINE_INSTRUCTION`** (`goal_loop.py`, next to the existing constants).
  Framing (draft):
  > "## Goal planning — refining the plan with the user
  > The user is giving feedback on the plan you already wrote to `GOAL_PLAN.md`.
  > Read the current file, apply their requested changes, and save the updated
  > plan. In your chat reply, briefly say what you changed and invite further
  > edits. Do NOT start doing the work — the user reviews and may keep refining
  > before approving."

- **Also tighten `PLANNING_INSTRUCTION`** to explicitly open a conversation:
  "…In your chat reply, summarise the plan and invite the user to request changes
  — you'll refine it together before they approve."

- **Dispatch on phase** (`chat.py`, the `if not is_goal / elif …` block ~730):
  ```python
  if not is_goal:
      driver = chat_driver
  elif thread.goal_status in (GoalStatus.idle, GoalStatus.planning):
      driver = planning_driver          # first plan → PLANNING_INSTRUCTION
  elif thread.goal_status == GoalStatus.awaiting_approval:
      driver = planning_driver          # refine → REFINE_INSTRUCTION
  elif not thread.require_plan_approval:
      driver = autonomous_driver
  else:
      driver = planning_driver
  ```
  `planning_driver` picks its instruction from `thread.goal_status`
  (`awaiting_approval` → `REFINE_INSTRUCTION`, else `PLANNING_INSTRUCTION`).
  This also resolves the "message after completion re-plans" behavior: for a
  terminated goal (`completed`/`blocked`/`failed`/`stopped`) a new message
  **starts a fresh planning round** — reset `goal_status` to `planning`, run
  `PLANNING_INSTRUCTION`, and require Approve again before any work.

- **Seed planning history from the DB.** In `planning_driver`, load the persisted
  transcript (as `autonomous_driver` does at `chat.py:738-745`) and pass it as
  `message_history` so refinement is robust across reconnect. Keep relying on the
  plan doc on disk for the detailed plan body.

- **Composer stays in planning mode = server-enforced.** Because dispatch is now
  phase-based and only `/goal/approve` can move to execution, no message can ever
  trigger the autonomous loop while approval is required. This is the backbone of
  the "composer stays in planning mode" guarantee — enforce it server-side, don't
  rely on the frontend.

### 4.2 Frontend — make the conversation obvious

- **Banner copy + affordance** (`GoalPanel.tsx` `GoalBanner`, `awaiting_approval`
  branch): headline like "Draft plan — chat below to refine, or approve to run",
  keep the Approve button, and show a subtle "plan updated" indicator when a
  refinement turn rewrites `GOAL_PLAN.md`.

- **Composer placeholder while `awaiting_approval`**
  (`workspace-chat-page.tsx`): switch to "Ask for changes to the plan…" so
  refining is discoverable. Send button stays the normal send (no execution
  affordance until Approve).

- **Plan-updated signal.** Optional: when a planning/refine turn finishes, nudge
  the file panel to refresh `GOAL_PLAN.md` (it may already be open) and flash the
  banner indicator. Reuses the existing `requestOpenFile` path.

- **No new execution triggers.** Approve remains the only control that starts the
  loop; everything else is conversation.

### 4.3 Prompts summary

| Turn | Trigger | Instruction |
|---|---|---|
| First plan | `goal_status ∈ {idle, planning}` | `PLANNING_INSTRUCTION` (write draft, open conversation) |
| Refine | `goal_status == awaiting_approval` | `REFINE_INSTRUCTION` (read + revise existing doc) |
| Execute | `POST /goal/approve` | `EXECUTION_KICKOFF` (unchanged) |

## 5. Files likely touched

Backend:
- `backend/app/agents/goal_loop.py` — add `REFINE_INSTRUCTION`; tweak
  `PLANNING_INSTRUCTION` wording.
- `backend/app/api/chat.py` — phase-based dispatch; `planning_driver` picks
  instruction by `goal_status` and seeds `message_history` from the DB.
- (No model/migration changes — reuses existing `Thread.goal_status`.)

Frontend:
- `frontend/src/components/chat/GoalPanel.tsx` — banner copy / "refine" framing /
  plan-updated indicator.
- `frontend/src/pages/chat/workspace-chat-page.tsx` — composer placeholder during
  `awaiting_approval`; optional plan-refresh nudge.

Tests:
- `backend/tests/test_goal_chat.py` — add a case: goal thread → first planning
  turn (`PLANNING_INSTRUCTION`, `awaiting_approval`) → second message uses
  `REFINE_INSTRUCTION` and stays in `awaiting_approval` (never executes) →
  approve → execution runs. Assert no autonomous turn fires before approve.

## 6. Build phases

- **P1 — Backend conversation.** `REFINE_INSTRUCTION`, phase-based dispatch,
  DB-seeded planning history, tests. Fully testable offline with the existing
  `TestModel` + fake evaluator.
- **P2 — Frontend framing.** Banner copy, composer placeholder, plan-updated
  indicator.
- **P3 — Polish (optional).** Plan-changed diff/indicator, decide behavior for a
  message sent after a goal terminates.

## 7. Resolved decisions

1. **After a goal terminates** (completed/blocked/failed/stopped) → a new message
   **starts a fresh planning round** (reset to `planning`, require Approve again).
2. **"Plan updated" signal** → **lightweight banner indicator** + refresh the open
   `GOAL_PLAN.md`. No diff view.
3. **No skip-approve fast-path** → every goal goes through explicit Approve; a
   planning turn can never trigger execution.
4. **Prompt wording** → use the drafted `PLANNING_INSTRUCTION`/`REFINE_INSTRUCTION`
   copy in §4.1; refine during the implementation PR.

## Implementation notes (what shipped)

Backend:
- **`backend/app/agents/goal_loop.py`** — added `REFINE_INSTRUCTION` (frames the
  turn as revising the existing `GOAL_PLAN.md`); softened `PLANNING_INSTRUCTION`
  to open a back-and-forth planning conversation.
- **`backend/app/api/chat.py`** — `planning_driver` now selects its instruction by
  phase: `awaiting_approval` → `REFINE_INSTRUCTION`, otherwise `PLANNING_INSTRUCTION`.
  A terminated goal receiving a new message re-enters a fresh planning round
  (planning_driver resets `goal_status` to `planning`). Documented that approval
  (`POST /goal/approve`) is the sole path to execution — no planning message can
  start the autonomous loop.

Frontend:
- **`frontend/src/components/chat/GoalPanel.tsx`** — `GoalBanner` awaiting-approval
  copy now reads "Chat to refine it, or approve…"; added a `planUpdated` "Plan
  updated" pill.
- **`frontend/src/pages/chat/workspace-chat-page.tsx`** — edge-detects each entry
  into `awaiting_approval`; a 2nd+ entry for a thread means the plan was revised,
  so it flashes the pill and re-requests the plan doc. Composer placeholder is
  phase-aware ("Ask for changes to the plan, or approve to run…" while awaiting).

Tests:
- **`backend/tests/test_goal_chat.py`** — `test_goal_planning_conversation_refines_before_approval`:
  first message drafts (PLANNING_INSTRUCTION) → second message refines
  (REFINE_INSTRUCTION) and stays `awaiting_approval` (never executes) → approve →
  runs to `completed`.

**Deviation from §4.1 (DB-seeded planning history):** dropped. `useChat` sets the
agent's messages to the full transcript before every run (`setMessages`, and it
loads history from the API on thread open), and `run_stream` *appends* the
request's messages to `message_history` — so re-seeding from the DB would
duplicate the entire transcript. The request adapter already carries full
conversational context (and image attachments), so planning turns keep using it.

## Follow-up: mid-run interjection (running-goal UX, 2026-07-16)

While a goal is executing, the composer is back (previously replaced by a bare
"Stop goal" button) so the user can steer the run without stopping it.

- **Backend buffer** — `goal_loop.py` adds a per-thread interjection store
  (`queue_interjection` / `drain_interjections`) and `weave_interjections(seed,
  pending)`, which leads the next turn's seed with the user's message followed by
  the continue directive. `_run_goal_execution.run_turn` drains + weaves at each
  turn boundary, so a message folds into the *next* turn (it doesn't interrupt the
  turn in flight).
- **Endpoint** — `POST /threads/{id}/goal/interject` (`chat.py`): validates a goal
  thread with a live run, persists the message to the transcript, and buffers it.
  Can't reuse `POST /chat` because the autonomous run streams as one lifecycle and
  a second run would 409.
- **Frontend** — `threadsApi.interjectGoal`, `useChat.interject` (optimistically
  appends the user bubble), and a running-goal composer with a "send a message to
  steer it" + **Stop goal** bar above it. The composer renders with
  `isSending={false}` so a message sends immediately (interjects) instead of
  joining the send queue; mode dropdown/attachments are hidden in this mode.
- **Tests** — `test_goal_loop.py` covers the weave/store and that an interjection
  queued during turn 1 lands in turn 2's seed; `test_goal_chat.py` covers the
  endpoint guards (non-goal / no active run / unknown thread).
