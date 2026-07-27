# PLAN: Clear context when executing a plan (plan → execute handoff)

Status: **SIMPLIFIED to Option A** (see note below); originally Option C
Owner: jon
Date: 2026-07-23

## Update (2026-07-23) — simplified to Option A

The Option-C machinery below (compacting the planning rows, a `divider` seam, a
`goal_brief` card, the client `resetMessages` mirror) was removed. A goal run's
context is set entirely by `initial_history` + the kickoff — it never uses the
visible transcript — so "clean context" needs nothing more than seeding
`execute_plan` with `initial_history = []`. The approved plan still rides in via
`plan_execute_kickoff(plan_path, doc_text)` and the doc's Success Criteria is the
evaluator condition, so the refinement back-and-forth never reaches the model. The
planning conversation now stays visible in scrollback (harmless), the `divider`
and `goal_brief` message kinds are gone, and the execute turn shows a normal
bubble. The GoalRunPanel already surfaces the objective + criteria during the run.
`extract_plan_title` is kept (sets the goal header via `thread.goal`).

The Option-C write-up is retained below for history only.

## Implementation notes (what shipped)

Decisions locked with jon: **Option C** (compact boundary, no summarizer call), a
**divider line**, and **keep the whole-doc fallback** for `extract_success_criteria`.

Backend (`backend/app/api/chat.py`, `is_execute_plan` branch):
- After deriving the goal condition, all currently-visible (`compacted == False`)
  rows are marked `compacted = True` (planning transcript + the bodyless "Execute
  plan" turn), reusing the `/compact` hiding mechanism — kept in the DB, hidden from
  the UI and from model context.
- A `role="assistant", kind="divider"` message (`Executing plan — {plan_path}`) is
  inserted to mark the handoff, in the same commit as the goal/park updates.
- The shared goal-history query now also excludes `kind == "divider"`, so dividers are
  never sent to the model. For `execute_plan` this makes `initial_history == []` — the
  loop starts from the plan-execute kickoff alone (which avoids seeding history with a
  lone leading model-response, which some providers reject). `/goal` is unaffected.

Frontend:
- `MessageKind` gains `"divider"` (`frontend/src/api/types.ts`).
- `AssistantSegment` renders a `kind="divider"` message as a labelled horizontal rule
  (`frontend/src/components/chat/AssistantGroup.tsx`), styled like the `summary` card's
  seam but as a line, not a bordered card.

Tests (`backend/tests/test_goal_chat.py`):
- `test_execute_plan_clears_planning_context_and_leaves_a_divider` — execute compacts
  the planning rows, seeds the loop with `initial_history == []`, and leaves exactly
  one divider pointing at the plan doc.
- `test_goal_command_keeps_its_transcript` — regression: a bare `/goal` compacts
  nothing and adds no divider.

### Follow-up 1 — live client sync (2026-07-23)

First cut only changed the DB, so during the execution run the client still showed the
stale planning transcript + the "Execute plan" bubble and no separator; it corrected
only on a manual reload. Fixed so the seam is visible immediately:
- `handleExecutePlan` (`workspace-chat-page.tsx`) reads the plan doc and, before
  sending, calls `resetMessages([divider, goal_brief])` — clearing the planning
  transcript from view and showing the seam + brief right away. The streamed execution
  turns append below; a reload swaps in the server's identical rows.
- `performSend` (`useChatEngine.ts`) no longer appends a user bubble for
  `execute_plan` (the divider replaces it); the transport still carries the turn.

### Follow-up 2 — surface the goal detail (2026-07-23)

jon wanted the execution to read as more than a bare "Execute plan". Four changes:
- **Richer divider** — carries the plan's H1 title as the objective (`Executing plan —
  <title>`), not the raw path (`extract_plan_title`).
- **Goal brief card** — a new `kind="goal_brief"` message surfaces the Success Criteria
  (what "done" means) as a card, so the user sees what the agent is set to do without
  reading the seed. UI-only (excluded from model context alongside `divider`).
- **Inlined kickoff** — `plan_execute_kickoff(plan_path, plan_body)` now reproduces the
  full plan in the seed, so the model has the objective/steps/criteria from turn one
  (it may still re-read the file).
- **Goal header** — `thread.goal` is set to the plan title, so the goal-mode header
  reads the objective rather than "Fully implement the plan at <path>".

Client parsing (`planTitle` / `planSuccessCriteria` in `lib/plan-doc.ts`) mirrors the
backend (`extract_plan_title` / `extract_success_criteria`) so the optimistic rows match
the persisted ones. Both `divider` and `goal_brief` are excluded from the model-context
query, so `execute_plan` history stays empty (`initial_history == []`).

### Follow-up 3 — enforce plan mode at the tool layer (2026-07-23)

Observed with qwen-max: a `/plan` turn started *building* (todo board + edits) instead
of writing a plan doc. Root cause (pre-existing, not from this work): `/ask` is enforced
by a read-only tool allowlist, but plan mode was only enforced by the planning *prompt*
("do not build yet") — which weaker models ignore. Fixed by enforcing plan mode at the
tool layer, mirroring `/ask`:
- `_PLAN_TOOL_ALLOWLIST` + `_plan_tool_filter` (`agents/builder.py`): the read-only
  surface **plus `write_file`** (to write the plan doc) and **minus the todo-board
  tools** (`write_todos`/`add_todo`/…). `edit_file`/`execute`/`task`/shell stay out, so
  a plan turn can research and write its doc but cannot build. A refinement rewrites the
  doc via `write_file`.
- `build_deep_agent(plan_mode=…)` applies the filter, and also turns off browser QA and
  the dev-server directive for plan turns.
- `chat.py` computes `plan_mode` (fresh `/plan`, or a plain message on a parked plan) and
  threads it through `_build_agent_and_context`.
- Tests: `test_build_deep_agent_plan_mode_allowlists_tools` (mirrors the read-only test).

### Follow-up 4 — drop the plan-mode tool gate (2026-07-27)

Follow-up 3 is **reverted**: `_PLAN_TOOL_ALLOWLIST` and `_plan_tool_filter` are gone and
plan mode no longer filters tools. Gating the toolset traded one failure for worse ones on
weaker/local models:

- With no todo board and no delegation, local reasoning models (GLM/DeepSeek via vLLM)
  scaffold a plan by laying out a todo list first; stripped of that they answered in prose
  and never called `write_file`, so a `/plan` turn produced **no plan doc at all** — a
  harder failure than a plan turn that edits a file.
- The filter also removed the local web-search tool (registered as `duckduckgo_search`,
  which the allowlist never named), and on an `OpenAIChatModel` a native `WebSearchTool`
  with no surviving local fallback raises `WebSearchTool is not supported with
  OpenAIChatModel` at request build — so a plan turn with web search on failed instantly.

A plan turn now sees the same toolset as a build turn and is held to planning by
`planning_instruction()` ("Plan mode — propose, do NOT execute yet … make no changes").
`plan_mode` still turns off browser QA and the dev-server directive. `/ask` keeps its
read-only allowlist — there the no-write guarantee is the feature, not a nudge.

- Tests: `test_build_deep_agent_plan_mode_keeps_full_toolset` asserts plan mode's tool set
  equals a normal build turn's, and that `write_file`/`write_todos`/`task` survive.

---

## Original plan (retained for context)

## Problem

When a parked plan is executed ("Execute plan", `turn == "execute_plan"`), the goal
loop is seeded with the **entire planning transcript**:

```python
# backend/app/api/chat.py:1133-1140  (shared by /goal and execute_plan)
rows = select(Message).where(
    Message.thread_id == thread_id, Message.compacted == False
).order_by(Message.created_at)
initial_history = messages_to_history(rows)
```

That transcript is the *source* the plan doc was compiled from. The kickoff already
points the agent at the doc (`plan_execute_kickoff`, `goal_loop.py:217`) and the
evaluator condition is the doc's `## Success Criteria` (`chat.py:1116`). Re-injecting
the raw planning back-and-forth on top of that is:

- **Redundant** — the plan doc distills every decision already; the chat that produced
  it is duplicated context.
- **Costly** — a long refine conversation bloats every execution turn from turn 1.
- **Drift-prone** — the model sees abandoned approaches and rejected ideas from the
  planning phase, not just the approved plan.

## Goal

Treat **"Execute plan" as a context boundary**: when a parked plan is executed, drop
the planning transcript from the execution loop's context and seed the loop from the
plan doc alone (kickoff references the file; `## Success Criteria` is the evaluator
condition, re-cited each turn via `goal_continue_directive`).

**Scope is `execute_plan` only.** A bare `/goal` command is unchanged — its objective
*is* the conversation, there is no compiled artifact to seed from.

## Why this is safe

- The plan doc is designed to be self-contained: `planning_instruction()`
  (`goal_loop.py:125`) requires a full ordered checklist, key decisions/assumptions,
  and a `## Success Criteria` section, and the user reviewed it before executing.
- The completion anchor survives the reset: the evaluator judges against `condition`
  (= the doc's success criteria) and `goal_continue_directive(condition, reason)`
  re-cites it into context every turn (`goal_loop.py:481`). An empty starting history
  does not un-anchor the loop.
- Backend fully owns execution-turn context: goal turns run through
  `build_continuation_adapter` with `message_history` from `initial_history`
  (`_run_goal_execution`, `chat.py:704-755`). The frontend-sent transcript is
  discarded for goal runs, so this is a pure backend change.

## Key existing mechanism to reuse

The `compacted` flag is already the in-thread context-boundary primitive:

- `Message.compacted` (`models.py:496-501`) — a row marked compacted stays in the DB
  (scrollback intact) but is hidden from the UI and from context.
- **Both** history-assembly paths already filter it: the chat/list path
  (`threads.py:103`) and the goal path (`messages_to_history`, `goal_loop.py:283`,
  and the query at `chat.py:1136`).
- `/compact` (`chat.py:1250`, `agents/compaction.py`) marks rows compacted and inserts
  a `kind="summary"` card, rendered distinctly at `AssistantGroup.tsx:68`.

Because `messages_to_history` already excludes compacted rows, **marking the planning
messages compacted in the `execute_plan` branch is sufficient** — the existing
`initial_history = messages_to_history(rows)` then naturally seeds from nothing but
the kickoff + doc. Line 1140 need not change.

## Options considered

| Option | What it does | Cost | UI |
|---|---|---|---|
| **A — empty seed** | Skip the transcript entirely for execute (e.g. `initial_history = []`), leave planning rows untouched in the DB | None | No visible boundary |
| **B — summarize first** | Run `summarize_thread` over planning rows, mark them compacted, seed from the `kind="summary"` card | Extra model call + latency; summary duplicates the doc | Summary card |
| **C — compact boundary, no summarizer (recommended)** | Mark planning rows `compacted=True`; insert a lightweight `kind="plan"` divider card ("Executing PLAN-x.md"); seed from doc only | None (no model call) | Divider card; transcript preserved in DB |

**Recommendation: C.** The plan doc *is* the summary, so B's summarizer call is wasted;
A is cheapest but leaves no readable boundary and doesn't hide the planning rows from a
later `/compact` or reload. C reuses the `compacted` primitive, keeps the thread
readable, preserves the planning convo in the DB, and costs no model call.

## Proposed change (Option C)

All edits in the `is_execute_plan` sub-branch of `chat.py` (`chat.py:1107-1128`),
**before** the shared history query at `chat.py:1133`:

1. After deriving `goal_condition` / `goal_kickoff` and clearing the park, load the
   thread's currently-visible (`compacted == False`) messages.
2. Mark those planning rows `compacted = True` and `session.add` them.
3. Insert one `kind="plan"` (divider) assistant message, e.g.
   `"▶ Executing plan — {plan_path}"`, so the transcript reads as a clean handoff.
4. `commit` (this branch already commits at `chat.py:1127`).
5. Leave the shared query + `initial_history = messages_to_history(rows)` unchanged —
   it now returns only the divider row (or nothing), plus the loop's kickoff.

Sketch (illustrative, not final):

```python
if is_execute_plan:
    plan_path = thread.plan_path
    if not plan_path:
        raise HTTPException(409, "No plan to execute for this conversation")
    doc_text = read_plan_doc(workspace.path, plan_path)
    goal_condition = extract_success_criteria(doc_text) or doc_text.strip()
    if not goal_condition:
        raise HTTPException(409, "The plan doc is empty or unreadable")

    # Context boundary: the plan doc is the compiled context, so drop the
    # planning transcript from the execution loop. Rows stay in the DB
    # (scrollback intact); messages_to_history already filters compacted.
    planning_rows = (await session.execute(
        select(Message).where(
            Message.thread_id == thread_id, Message.compacted == False  # noqa: E712
        )
    )).scalars().all()
    for row in planning_rows:
        row.compacted = True
        session.add(row)
    session.add(Message(
        thread_id=thread_id, role="assistant", kind="plan",
        content=f"Executing plan — {plan_path}",
    ))

    thread.goal = f"Fully implement the plan at {plan_path}."
    thread.success_criteria = goal_condition
    thread.status = ThreadStatus.running
    session.add(thread)
    await session.commit()
    goal_kickoff = plan_execute_kickoff(plan_path)
else:
    goal_condition = condition
    goal_kickoff = AUTONOMOUS_KICKOFF

# shared, unchanged:
rows = select(Message).where(..., Message.compacted == False)...
initial_history = messages_to_history(rows)
```

## Scoping guarantees

- **`/goal`** — never enters the `is_execute_plan` sub-branch; full transcript still
  seeds the loop. Unchanged.
- **Plain chat / `/ask` / `/plan` refine** — untouched; they don't run the goal loop.
- **Execute plan** — planning rows compacted, loop seeded from kickoff + doc only.

## Files likely touched

- `backend/app/api/chat.py` — the `is_execute_plan` branch (~`1107-1128`): compact
  planning rows + insert divider before the shared history query.
- `frontend/src/components/chat/AssistantGroup.tsx` — render the `kind="plan"` divider
  card (only if we don't reuse the existing `kind="summary"` rendering). Optional.
- `frontend/src/api/types.ts` — confirm `"plan"` is an accepted `MessageKind` for the
  divider (it already exists as a turn kind).

## Tests

- `backend/tests/test_goal_chat.py`:
  - Execute plan → planning messages are marked `compacted`; `initial_history` passed to
    the goal loop excludes them (seeded from kickoff + doc only).
  - A `kind="plan"` divider row is inserted.
  - `success_criteria` / `goal` still derived from the doc (existing assertions hold).
  - **Regression:** a bare `/goal` turn still seeds the loop from the full transcript
    (no rows compacted).
- Manual: `/plan` → refine a few times → Execute → verify execution turns no longer
  carry the planning chat (token count / transcript), goal still completes against the
  doc's Success Criteria, and scrollback still shows the (now-collapsed) planning convo.

## Open questions (resolve before implementing)

1. **A / B / C** — confirm C (recommended). If jon prefers a carry-forward summary of
   anything not in the doc, switch to B.
2. **Divider card** — new `kind="plan"` divider vs. reuse the existing `kind="summary"`
   card styling vs. no card at all (Option A). Recommendation: a distinct `kind="plan"`
   divider so it doesn't read as a lossy `/compact` summary.
3. **Empty-criteria fallback** — today `extract_success_criteria` falls back to the
   whole doc when `## Success Criteria` is absent (`goal_loop.py:174`). With context
   cleared, that fallback is load-bearing. Keep the fallback, or hard-require the
   section and refuse to execute without it? Recommendation: keep the fallback (matches
   current behavior); revisit if it proves weak.

## Out of scope

- Changing `/goal` (no-plan) seeding.
- A general "hard clear, keep thread" endpoint (this reuses `compacted` only at the
  execute boundary; a standalone clear command is a separate idea).
- Mid-execution steering / interjections (unaffected — they inject at the
  model-request boundary independent of initial history).
