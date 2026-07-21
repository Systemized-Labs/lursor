# PLAN: Plan → Refine → Execute-as-Goal flow

Status: **IMPLEMENTED** (2026-07-21)
Owner: jon
Date: 2026-07-21

## Implementation notes

Resolved the remaining open questions during implementation:
- **Execute trigger:** a bodyless-intent turn `turn == "execute_plan"` through the
  existing `/chat` pipeline (reuses all goal streaming/reconnect infra) — no new
  endpoint. The button sends a visible "Execute plan" message; its text is ignored.
- **Doc → goal:** `goal = "Fully implement the plan at {plan_path}."`,
  `success_criteria` = parsed `## Success Criteria` section (falls back to whole doc).
- **Refine badge:** a plain message while parked persists as `kind="plan"` so the
  transcript reads as one planning conversation; the execute turn persists as `goal`.

Changed files: `backend/app/agents/goal_loop.py`, `backend/app/api/chat.py`,
`frontend/src/api/types.ts`, `frontend/src/agui/useChatEngine.ts`,
`frontend/src/pages/chat/workspace-chat-page.tsx`, plus tests in
`backend/tests/test_goal_chat.py` and `backend/tests/test_goal_loop.py`.

## Problem

Yesterday's refactor (`587449f refactor: simplify slash plan flow`) removed the sticky
plan mode and made `/plan` a per-turn intent. That inverted the meaning of a plain
follow-up message while a plan is parked:

- **Before:** plain follow-up = *refine the plan*; you exited plan mode (✕) to execute.
- **After:** plain follow-up = *execute/implement the plan*; you must re-type `/plan …`
  to refine.

Result: user writes a plan, asks for a change in a plain message, and the model
implements the change directly instead of refining the plan doc. This is the observed
pattern.

## Goal

Three distinct phases with a human checkpoint between each:

1. **Write a plan doc** — `/plan` writes `.agents/plan/PLAN-<slug>.md`, thread parks in
   `awaiting_approval`.
2. **Refine the plan doc** — plain follow-up messages edit *that doc*, staying parked.
   Nothing executes.
3. **Execute as a goal** — an explicit **"Execute plan"** button hands the finished doc
   to the `/goal` loop, which implements it.

## Decisions (confirmed with jon)

- **Phase 2:** while parked (`awaiting_approval`), a plain follow-up message = **refine**
  the plan doc. Execution only happens via the explicit Phase-3 action.
- **Phase 3 trigger:** an **"Execute plan" button** on the parked plan (not a command).
- **Doc → goal mapping:** the plan doc itself defines a **Success Criteria** section; the
  goal loop is seeded with objective ≈ `"Fully implement this plan: {path to plan doc}"`
  and `success_criteria` drawn from the doc's Success Criteria section.
- **Fresh `/plan` on a parked thread:** starts a **brand-new** plan doc (does NOT refine
  the existing one). Refinement is now what plain follow-ups do; `/plan` always means
  "start a new plan."
- **Success Criteria mapping:** parse the doc's `## Success Criteria` section for the
  evaluator, and **fall back to the whole doc** if that heading is absent. (Chosen for a
  focused evaluator signal while staying robust to malformed docs.)

## Why not just adopt deepagents / pydantic-deepagents?

Researched `pydantic-deepagents` planning
(<https://vstorm-co.github.io/pydantic-deepagents/learn/planning/>). Its model is a
**continuous** `write_todos` loop — plan and execute interleaved in one run, todos in
agent state, **no plan doc, no refinement phase, no approval gate**. That is the opposite
of the human checkpoint we want. We keep our plan-doc model (which is already closer to
the target) and borrow only the *mechanics* worth borrowing (see "Optional" below).

Our existing building blocks already cover most of this:

- Plan doc on disk: `.agents/plan/PLAN-<slug>.md` (`goal_loop.py` `PLAN_DIR`,
  detected via `scan_plan_dir` / `detect_written_plan`).
- Parked state: `ThreadStatus.awaiting_approval`, `thread.plan_path`.
- Autonomous execution: `/goal` loop (`drive_goal_loop`, `_run_goal_execution`).

What's broken/missing is only the **phase boundaries**: phase-2 routing, and a phase-3
handoff from plan doc → goal.

## Current code (reference points)

- `backend/app/api/chat.py:895-896` — plain `chat` turn on a parked thread clears the park
  and runs `chat_driver` (implementation). **← the inversion to fix.**
- `backend/app/api/chat.py:917-922` — refinement only when `turn == "plan"` AND
  `awaiting_approval`; else fresh `planning_instruction()`.
- `backend/app/api/chat.py:884-885` — goal seeding: `run_goal = turn == "goal"`;
  `condition = user_text or thread.success_criteria or thread.goal`.
- `backend/app/api/chat.py:998-1032` — `goal_driver` → `_run_goal_execution(..., kickoff=AUTONOMOUS_KICKOFF)`.
- `backend/app/agents/goal_loop.py:124-159` — `planning_instruction()` / `refine_instruction(plan_doc)`.
- `backend/app/agents/goal_loop.py:162-166` — `AUTONOMOUS_KICKOFF` (goal kickoff text).
- `backend/app/db/models.py:441-450` — `goal`, `success_criteria`, `status`, `plan_path`.
- `frontend/src/pages/chat/workspace-chat-page.tsx:282-284` — plain send always goes as
  `"chat"`. **← phase-2 frontend change.**
- `frontend/src/components/chat/commands/registry.ts` — `/plan`, `/goal` command defs.

## Proposed changes

### Phase 2 — plain follow-up refines a parked plan

**Backend (`chat.py`):**
- Treat a plain turn on an `awaiting_approval` thread as a refinement: when
  `turn == "chat"` and `thread.status == awaiting_approval`, route to `plan_driver` with
  `refine_instruction(thread.plan_path)` instead of clearing the park and running
  `chat_driver`.
- Remove/replace the auto-clear at `chat.py:895-896`. The park is cleared only by the
  explicit Execute action (phase 3).
- **Fresh `/plan` on a parked thread starts a NEW doc** (does not refine). This means
  `chat.py:917-922` changes: `/plan` always uses `planning_instruction()` and lets the
  agent name a fresh `PLAN-<slug>.md`; it no longer branches into `refine_instruction`.
  Refinement moves entirely to the plain-follow-up path above. (`refine_instruction` is
  still used — just driven by plain turns while parked, not by `/plan`.)
- `/ask` stays read-only and must NOT refine or execute — leave parked plan untouched.

**Frontend (`workspace-chat-page.tsx`):**
- No change to how plain messages are *sent* (still `"chat"`); the backend decides
  refine-vs-execute based on parked status. (Alternative: send `"plan"` when parked — decide
  during review. Backend-side is preferred so the UI stays dumb.)
- Composer placeholder while parked: e.g. "Refine the plan, or press Execute to run it."

### Phase 3 — "Execute plan" button → goal loop

**Frontend:**
- Add an **"Execute plan"** button on the parked-plan card / plan view (both desktop
  `workspace-chat-page.tsx` and `mobile-plan-view.tsx`).
- On click, call a new endpoint (or a dedicated turn intent, e.g. `turn: "execute_plan"`)
  that starts the goal loop for `thread.plan_path`.

**Backend:**
- New branch (parallel to `run_goal`) that:
  - Reads the plan doc at `thread.plan_path`.
  - Sets `thread.goal = "Fully implement this plan: {plan_path}"` and
    `thread.success_criteria` = the doc's `## Success Criteria` section (parsed from the
    Markdown — the heading and its body up to the next `##`; **fallback to the whole doc**
    if the section is absent).
  - Clears `awaiting_approval` and runs `_run_goal_execution(...)` with a plan-aware
    kickoff, e.g. `PLAN_EXECUTE_KICKOFF = "Read the plan at {plan_path} and fully
    implement it. Break it into steps with the write_todos tool…"` (variant of
    `AUTONOMOUS_KICKOFF`).

**Plan doc convention:**
- `planning_instruction()` / `refine_instruction()` updated to require a
  `## Success Criteria` section in every plan doc, so phase 3 has something concrete to
  hand the evaluator.

## Resolved

- **Fresh `/plan` on a parked thread** → starts a brand-new plan doc. `/plan` = "start a
  new plan"; refinement is the plain-follow-up path.
- **Success Criteria mapping** → parse the `## Success Criteria` section; fall back to the
  whole doc if absent.

## Open questions (resolve during iteration)

1. **Endpoint vs turn intent** for the Execute button — reuse the chat/turn pipeline with
   a new `turn: "execute_plan"`, or a dedicated `POST /threads/{id}/execute-plan`?
2. **Mid-execution steering** — after Execute, the thread is a running goal; plain messages
   already buffer as interjections (`goal_loop` `_goal_interjections`). Confirm that's the
   desired behavior post-execute.
3. **Discoverability of refine** — do we need any UI cue that plain messages now refine
   (vs. the old ModePill)? Placeholder text may be enough.

## Optional (borrow from deepagents mechanics, not the flow)

- Consider a dedicated `update_plan` tool (persistent-state overwrite) instead of relying
  on mtime-diff detection of `write_file`/`edit_file` — more robust plan-doc detection.
  Not required for this change; note for later.

## Out of scope

- Reintroducing sticky thread modes / ModePill.
- Changing `/goal` (no-plan) behavior.
- The `write_todos` internal todo tooling (unchanged).

## Rollout / testing

- Backend unit tests for: plain turn on parked thread → refine; Execute → goal seeded with
  doc-derived goal + success_criteria; `/ask` leaves park intact.
- Manual: `/plan` → plain "change X" refines the doc → "Execute plan" runs goal to
  completion against the doc's success criteria.
