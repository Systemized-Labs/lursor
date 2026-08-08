# Runs, intents and the goal loop

How a turn gets from the composer to the model and back. Indexed from
[`AGENTS.md`](../../AGENTS.md) §6.

## The run engine

```
POST /threads/{id}/chat
  → parse request + turn intent            api/chat.py
  → persist the user turn up front
  → _build_agent_and_context(session, …)   resolves providers, subagents, deep
                                           defaults, skills + their env vars
  → build_deep_agent(row, workspace_path,…)  agents/builder.py
  → AGUIAdapter.from_request(request, agent=agent)
  → pick a driver: chat | plan | goal | execute_plan
  → chat_run_manager.start_run(thread_id, driver)   detached asyncio.Task
  → return an SSE subscription to that run
```

**`chat_run_manager` is the load-bearing abstraction.** A run is an
`asyncio.Task` owned by the manager, not by the request: it buffers encoded SSE
lines (capped at 5000, 200 finished threads retained), fans out to subscribers,
and survives browser disconnect. The HTTP response is only a *subscriber*. This
is what makes reconnect, stop, and headless (scheduled) runs all work with no
extra machinery.

Its critical invariant: `subscribe()` snapshots the buffer and registers the
queue **with no `await` in between**, or events are lost in the gap.

Routes: `POST /{id}/chat` (start + stream), `GET /{id}/stream` (reconnect,
replays), `POST /{id}/stop`, `POST /{id}/goal/interject`, `POST /{id}/compact`.
`GET /threads/active-runs` **must be declared before `/{thread_id}`** or FastAPI
routes it as a thread id.

Per-turn budget: `TURN_REQUEST_LIMIT = 300` model requests
(`builder.py`), and subagents get their own budget of the same size.

`reconcile_interrupted_runs()` runs at startup — run state is in-memory only, so
a thread the last process left mid-run would otherwise show a live status pill
forever.

## Frontend: transport → store → view

```
transport   agui/agent.ts (HttpAgent) · agui/stream-reader.ts
                → one ChatEventHandlers sink, shared by BOTH transports
state       agui/chatStore.ts   Zustand, normalized: order[] + byId{}
controller  agui/useChatEngine.ts   send/stop/queue/load/reconnect
view        components/chat/ChatTimeline → MessageRow(id) → UserBubble
                                        | AssistantGroup, in <StickToBottom>
```

The normalized store is the fix for the chat surface's four chronic defects
(render flashes, scroll detach, streaming jank, older-message flash). A streamed
token mutates `byId[assistantId]`, so **only that row re-renders** — the timeline
subscribes to `order` alone. Leaf rows are `memo`'d. `StreamingText` splits into a
stable prefix and a growing tail so at most two markdown parses exist mid-stream.
Scroll is `use-stick-to-bottom`, never hand-rolled — it pins before paint.

`useChatEngine` guards that must survive any refactor: the `loadSeq` monotonic
guard, the `sendingThreadRef`/`loadedThreadRef` dedupe guards, and
`resolveAssistantId` for models that omit message ids.

## Turn intents, and the plan → refine → execute flow

There are **no sticky thread modes**. `ThreadMode` survives only so rows from
older builds still load; live threads stay `chat`. Everything is a per-turn
intent on `forwardedProps.turn`:

| intent | behaviour |
| --- | --- |
| `chat` | full agent, all tools. The default. |
| `ask` | read-only, enforced by an **allowlist** tool filter (`_READONLY_TOOL_ALLOWLIST`) |
| `plan` | writes/refines a plan doc at `.agents/plan/PLAN-<slug>.md`; parks the thread in `awaiting_approval` |
| `execute_plan` | hands the finished doc to the goal loop |
| `goal` | one-off autonomous loop, condition = the message text |

The three-phase flow, with a human checkpoint at each boundary:

1. `/plan <objective>` → drafts the doc, `status = awaiting_approval`. A fresh
   `/plan` on a parked thread always starts a **new** doc.
2. A **plain** follow-up while parked = *refine that doc* (persisted as
   `kind="plan"`), not implement it. This inversion has been got wrong twice;
   it is the behaviour users expect.
3. The explicit **Execute plan** button sends `turn == "execute_plan"`:
   `goal = <plan H1 title>`, `success_criteria = the doc's ## Success Criteria`
   (falling back to the whole doc), and the loop is seeded with
   **`initial_history = []`** — the plan doc *is* the compiled context, so the
   refinement back-and-forth never reaches the model. The planning transcript
   stays visible in scrollback.

Plan mode is **instruction-gated, not tool-gated**. Gating the toolset was tried
twice and reverted twice: without the todo board and delegation, local reasoning
models (GLM/DeepSeek via vLLM) answer in prose and never call `write_file`, so a
`/plan` turn produces *no plan doc at all* — a worse failure than a plan turn
that edits a file. The allowlist also silently dropped `duckduckgo_search`. A
plan turn now sees a normal toolset and is held to planning by
`planning_instruction()`. `plan_mode` still disables browser QA and the
dev-server directive. `/ask` keeps its allowlist — there the no-write guarantee
is the feature, not a nudge.

Slash commands are **data**, in `components/chat/commands/registry.ts`. Adding
one is a single declarative entry; the parser, menu, dispatch and pill are all
generic, keyed on `command.kind` (a closed set). Nothing in the UI shell grows.
The descriptor fields mirror Claude Code's frontmatter so a future markdown
command loader is additive.

`agentScope` on a command decides whether its default agent is a **per-turn
override** (`forwardedProps.agent_id`, never persisted — `/ask`, `/goal`,
Execute plan) or a **sticky reassignment** (`PATCH thread.agent_id` — `/plan`
only). Per-turn commands used to permanently steal the thread's agent; they
must not.

## The goal loop

`agents/goal_loop.py` (`drive_goal_loop`) wraps the vendored
`pydantic_deep.goal` engine: run a turn → evaluate the transcript against the
condition → continue with `goal_continue_directive(condition, reason)` or
terminate. Terminal states: `completed` (evaluator confirmed), `blocked`
(`impossible` verdict), `failed` (iteration cap), `stopped` (user).

- The evaluator **defaults to "not met" on any error** — a transient hiccup must
  never declare premature success.
- Recitation each turn is what stops drift on long loops.
- The evaluator model resolves through Lursor's provider stack
  (`build_goal_evaluator` + `AppConfig.goal_evaluator_model`). The library's
  default is an Anthropic Haiku, and there may be no Anthropic key.
- When a preview URL exists the evaluator is wrapped with visual QA, so
  completion is judged on what actually rendered, not on the transcript.
- Steering: plain messages during a run buffer as interjections and are woven
  into the next seed.
- **An autonomous run never has a human in it.** Nothing reads the agent's reply
  between turns, so a turn that ends "do you approve...?" is a dead turn — and a
  model that writes *"get user approval"* into the todo board poisons every later
  turn with work no run can complete. Three layers stop it, and all three are
  needed: `UNATTENDED_RUN_INSTRUCTION` is joined into the run-scoped instructions
  inside `_run_goal_execution` (so it lands on *every* turn, not just the kickoff,
  and covers `/goal`, Execute plan and cron alike); the plan-mode and
  execute-plan prompts say approval already happened (pressing the button *was*
  the approval — a plan must not contain checkpoint steps); and if a turn parks
  anyway, `looks_like_awaiting_user(turn.text)` swaps the plain continue directive
  for `awaiting_user_directive`, which grants the approval and forbids re-asking.
  The detector reads only the reply's closing ~400 chars, so mentioning approval
  mid-turn and then working on doesn't trigger it.

## Compaction — two mechanisms, one pair of knobs

- **In-run** (`agents/context_budget.py`): pydantic-deep's
  `ContextManagerCapability` hard-codes compaction at 90% of the budget keeping
  nothing verbatim, and exposes no passthrough. We **mutate the capability the
  library already built** (keeping its limit warner, `compact_conversation` tool
  and history-archive search) to apply `compaction_threshold` and
  `compaction_ratio`. It also repoints the summarizer onto our stack — the
  library only inherits the primary model when it was passed as a *string*, and
  every Lursor run passes a built `Model` object, so it silently fell back to
  `anthropic:claude-haiku-4-5` and raised on the first compaction.
- **Manual `/compact`** (`agents/compaction.py`): condenses the stored
  *transcript* into a `kind="summary"` assistant message and marks the rows it
  subsumes `compacted` — kept in the DB, hidden from the UI and from model
  context. `Message.compacted` is the general in-thread context-boundary
  primitive; both history-assembly paths already filter it.
