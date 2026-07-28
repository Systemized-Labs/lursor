# PLAN: Scheduled jobs (cron)

> Status: **IMPLEMENTED** (2026-07-28). See §11 for where the build deviated from
> this plan and why.
>
> Scope: a `Schedule` row that fires a prompt at a cron expression, in one
> workspace, on one agent, as either a single chat turn or an autonomous goal
> run. Each fire opens a fresh conversation. An in-process asyncio scheduler
> drives it, so schedules fire only while Lursor is running; missed fires are
> reported, never replayed. One new top-level UI destination.
>
> Explicitly out of scope: an always-on daemon (launchd/systemd), event triggers
> (file watch, webhook), chained/dependent jobs, notifications outside the app.
> See §9.

## 0. Why this is small

Almost all of the machinery a scheduled run needs already exists, because goal
mode needed the same things.

**A run is already detached from HTTP.** `ChatRunManager.start_run(thread_id,
driver)` (`backend/app/agents/chat_run_manager.py:54`) owns each run as an
`asyncio.Task` and buffers its events; the SSE response is only a *subscriber*
(`backend/app/api/chat.py:1053`). Nothing about a run requires that a browser is
watching, or that one ever was. `GET /threads/{id}/stream`
(`backend/app/api/chat.py:1499`) attaches later and replays.

**A synthetic user turn is already a solved problem.** The single
request-coupled line in the chat path is `AGUIAdapter.from_request`
(`backend/app/api/chat.py:1245`). But the goal loop already builds adapters out
of nothing but a string: `build_continuation_adapter(agent, directive,
thread_id, accept)` (`backend/app/agents/goal_loop.py:375`) wraps one synthetic
`UserMessage` in a `RunAgentInput`. A cron fire *is* a synthetic user turn.

**Context assembly is already session-scoped, not request-scoped.**
`_build_agent_and_context` (`backend/app/api/chat.py:800`) takes an
`AsyncSession` and resolves providers, subagents, deep defaults, skills and the
env vars those skills carry (`load_skill_runtime`). A background session works
as well as a request one — the goal path already relies on that.

**The UI needs no chat work at all.** `useChatEngine`
(`frontend/src/agui/useChatEngine.ts:327`) already attaches to any thread that
appears in `GET /threads/active-runs` (`backend/app/api/threads.py:33`) when you
open it. A conversation a schedule created and is streaming into shows a running
badge in the sidebar and streams live the moment you click it, with no changes.

**Spend is already tracked.** `_persist_usage` (`backend/app/api/chat.py:449`)
tags every turn with a `kind`, so a new `"cron"` kind makes scheduled spend
visible in Analytics for free.

**Background-service and restart-cleanup precedents exist.**
`preview_service._poll_loop` (`backend/app/agents/preview_service.py:186`) is an
app-owned `asyncio.sleep` loop that retires when idle and never lets an
exception wedge the app. `reconcile_interrupted_runs`
(`backend/app/api/chat.py:412`) is the precedent for a startup pass that cleans
up what a killed process left behind.

What is genuinely missing: a table, a cron parser, a tick loop, a CRUD router,
one refactor, and a page.

## 1. Decisions

1. **New thread per fire.** Every fire creates a `Thread` in the schedule's
   workspace, titled from the schedule plus a local timestamp. Full isolation:
   no unbounded context growth, no `/compact` dependency, and each run's
   transcript, todos, diff and usage stand alone. The cost is sidebar volume —
   §6.4 handles that by filtering schedule-created threads out of the
   workspace's conversation list by default and giving them their own list on
   the Schedules page.

2. **Two run types: `chat` and `goal`.** A `chat` schedule runs exactly one turn
   (`chat_driver`, `backend/app/api/chat.py:1279`) — cheap, bounded, predictable.
   A `goal` schedule runs the autonomous loop (`_run_goal_execution`,
   `backend/app/api/chat.py:924`) with its own success criteria and
   `max_iterations`. Plan mode is not offered: a schedule that parks a doc in
   `awaiting_approval` and then never gets approved is a trap, and the plan path
   also mutates thread status in ways that assume a human is present.

3. **Missed fires are reported, not replayed.** The backend's lifetime is the
   app's lifetime (`frontend/electron/main.cjs` spawns it on launch and
   `killBackend`s it on quit), so a laptop closed over a weekend *will* miss
   fires. On startup, each enabled schedule whose `next_fire_at` is in the past
   gets one `missed` history row recording how many fires elapsed, and its
   `next_fire_at` rolls forward to the next future occurrence. Nothing runs.
   Opening the app after a weekend must never launch a burst of billable agent
   runs the user did not ask for at that moment.

4. **One run per schedule at a time.** If a schedule's previous fire is still
   running when the next is due, the new fire is skipped with a `skipped`
   history row. A nightly goal run that takes six hours must not stack.

5. **Timezone lives on the row.** An IANA name (`America/New_York`), defaulting
   to the host's zone at creation, with `zoneinfo` doing the arithmetic. "Every
   day at 9am" has to mean 9am local across DST; a naive or UTC-only schedule
   silently drifts by an hour twice a year.

6. **`croniter` for parsing, our own loop for firing.** APScheduler would bring
   its own jobstore and executor model, duplicating the `schedules` table and
   the `ChatRunManager` we already have — two sources of truth for what is
   running. `croniter` is a pure-Python next-occurrence calculator and nothing
   else; the loop is ~40 lines in the shape of `preview_service._poll_loop`.

7. **Schedules are a top-level destination**, beside Usage / LAIOS /
   Customization. A schedule spans workspace + agent + time, and the question it
   answers ("what will fire tonight, and what did last night's run do?") is
   inherently cross-workspace.

8. **No new transport, no new stream event type.** A scheduled run publishes
   through `chat_run_manager` exactly like any other, so both the live-send and
   reconnect paths are already correct. (This is the trap noted in the AG-UI dual
   transport memory; we avoid it by adding no event types.)

## 2. Data model

Two new tables in `backend/app/db/models.py`. Both are new, so `create_all`
(`backend/app/db/session.py:27`) creates them outright and
`_apply_lightweight_migrations` needs **no** `ALTER` work.

```python
class ScheduleRunType(StrEnum):
    """What a fire runs. Mirrors the per-turn intents in api/chat.py."""
    chat = "chat"   # one turn
    goal = "goal"   # autonomous loop until the evaluator is satisfied


class ScheduleFireStatus(StrEnum):
    """Outcome of one attempted fire."""
    launched = "launched"   # a run started (the thread carries its own status)
    skipped = "skipped"     # previous fire still running
    missed = "missed"       # the app was not running when it was due
    error = "error"         # the launch itself failed (bad agent, bad workspace)


class Schedule(TimestampMixin, table=True):
    __tablename__ = "schedules"

    name: str = Field(index=True)
    description: str = ""
    enabled: bool = True

    workspace_id: str = Field(foreign_key="workspaces.id", index=True)
    agent_id: str = Field(foreign_key="agents.id", index=True)

    # Standard 5-field cron ("30 9 * * 1-5"), validated on write by croniter.
    cron: str
    timezone: str = "UTC"          # IANA name; zoneinfo does the arithmetic

    prompt: str                    # the synthetic user turn each fire sends
    run_type: ScheduleRunType = Field(default=ScheduleRunType.chat)
    # goal runs only: what "done" means, and the hard turn cap. Mirrors
    # Thread.success_criteria / Thread.max_iterations, stamped onto each fire's
    # thread so the existing goal machinery reads them unchanged.
    success_criteria: str = ""
    max_iterations: int = 25

    # Scheduler bookkeeping. next_fire_at is the single source of truth for
    # "due", recomputed on create, on update, after every fire, and at startup.
    next_fire_at: datetime | None = Field(default=None, index=True)
    last_fired_at: datetime | None = None


class ScheduleRun(TimestampMixin, table=True):
    """History: one row per attempted fire, including the ones that did not run."""
    __tablename__ = "schedule_runs"

    schedule_id: str = Field(foreign_key="schedules.id", index=True)
    # The conversation the fire opened. Null for skipped/missed/error rows.
    thread_id: str | None = Field(default=None, foreign_key="threads.id")
    fired_at: datetime
    status: ScheduleFireStatus
    # For `missed`, how many occurrences elapsed while the app was closed.
    missed_count: int = 0
    detail: str = ""               # skip reason or launch error
```

Two model changes elsewhere, both additive:

- `Thread` gains `schedule_id: str | None` (indexed, nullable). This is what
  lets the sidebar keep scheduled conversations out of the main list and lets a
  schedule's history link to its runs. Needs one line in
  `_apply_lightweight_migrations` (`ALTER TABLE threads ADD COLUMN schedule_id
  VARCHAR`) — existing rows stay NULL and behave exactly as today.
- `Message.kind` gains `"cron"` as a value (no schema change, it is a plain
  `VARCHAR`) so the synthetic turn renders as machine-originated rather than as
  something the user typed. `MessageKind` in `frontend/src/api/types.ts:382`
  gains the member.

## 3. The refactor: one launch path

This is the only part with regression risk, so it is worth being precise.

`chat()` (`backend/app/api/chat.py:1088`) is ~410 lines that do four separable
things: parse the request, persist the user turn, build the agent, and then
define `chat_driver` / `plan_driver` / `goal_driver` as closures and hand one to
`chat_run_manager.start_run`. The scheduler needs the last two steps and none of
the first.

**Change:** extract the driver construction and launch into a module-level
coroutine in `chat.py`, called by both the endpoint and the scheduler.

```python
async def launch_run(
    session: AsyncSession,
    *,
    thread: Thread,
    agent_row: Agent,
    workspace: Workspace,
    adapter: AGUIAdapter,
    turn: str,                       # "chat" | "ask" | "goal" | "plan" | "execute_plan"
    instructions: str | None,
    kind: str = "chat",              # usage/message tag: adds "cron"
    ...
) -> None:
```

The endpoint keeps every bit of request parsing it has now and passes the
adapter it built from the request. The scheduler passes one from
`build_continuation_adapter`. Both converge on identical driver code — which is
the point: a scheduled run must not be able to drift from a manual one.

Then the headless entry point, also in `chat.py` (where every helper it needs
already lives — `_persist_message:329`, `_set_thread_state:370`,
`_build_agent_and_context:800`, `_stream_turn:681`, `_run_goal_execution:924`):

```python
async def start_scheduled_run(
    session: AsyncSession,
    *,
    thread: Thread,
    prompt: str,
    run_type: ScheduleRunType,
) -> None:
    """Start a run with no HTTP request behind it (see agents/scheduler.py).

    Persists `prompt` as a `kind="cron"` user turn, builds the agent from the
    thread's workspace/agent exactly as the endpoint does, wraps the prompt in a
    request-free adapter, and launches. Never raises past the caller's own
    handling: a bad schedule must not take the scheduler loop down.
    """
```

Details that matter:

- **`accept=None`.** `build_continuation_adapter` forwards the request's
  `Accept` header; a headless fire has none. Verify `AGUIAdapter(accept=None)`
  encodes SSE (`data:`-framed lines), because `readActiveStream`
  (`frontend/src/agui/stream-reader.ts:128`) parses exactly that. If it does
  not, pass `text/event-stream` explicitly.
- **No auto-titling.** `_schedule_auto_title` (`backend/app/api/chat.py:104`)
  only overwrites a title that still equals the placeholder; scheduled threads
  are titled deterministically up front, so it is simply not called.
- **Preview registration.** Keep `preview_service.register(workspace.id,
  deps.backend)` (`backend/app/api/chat.py:1482`) on this path too, so a dev
  server a scheduled run starts is still visible in the Preview panel and to
  the visual evaluator. This is also why the shared-backend-per-workspace
  invariant matters here.
- **Goal fires** stamp `thread.goal`, `thread.success_criteria` and
  `thread.max_iterations` from the schedule before launching, then reuse
  `_run_goal_execution` unchanged with `initial_history=[]` (a fresh thread has
  no history) and `kickoff=AUTONOMOUS_KICKOFF`.

## 4. The scheduler

New module `backend/app/agents/scheduler.py`, modeled on
`preview_service._poll_loop` (`backend/app/agents/preview_service.py:186`) — one
task, `asyncio.sleep`, and an exception handler that logs and keeps going.

```
TICK = 30s
```

30 seconds is the resolution: cron's finest granularity is a minute, so worst
case a job fires 30s late. A tighter tick buys nothing; a looser one risks
skipping a minute.

**Startup (`lifespan`, `backend/app/main.py:44`, after
`reconcile_interrupted_runs`):**

1. For every enabled schedule, recompute `next_fire_at`.
2. If the stored `next_fire_at` was in the past, count the elapsed occurrences
   (via `croniter`, capped at 100 to bound a schedule that has been off for a
   year), write one `missed` `ScheduleRun` with that count, and roll forward.
3. Start the tick task.

**Each tick:**

1. Load enabled schedules where `next_fire_at <= now(UTC)`. (One indexed query;
   the table is tiny.)
2. For each, in order: if a `ScheduleRun` for this schedule is `launched` and
   `chat_run_manager.is_running(that thread_id)` → write `skipped` and roll
   forward. Otherwise create the thread, call `start_scheduled_run`, write
   `launched`, set `last_fired_at`, roll `next_fire_at` forward from *now* (not
   from the missed slot, so a slow tick cannot cause a double fire).
3. Any exception from one schedule is caught, logged, written as an `error`
   history row, and the loop continues to the next. The tick task must be
   impossible to kill.

**Shutdown:** cancel the tick task in `lifespan`'s teardown alongside
`close_hindsight_clients`. In-flight runs are left alone — `ChatRunManager` and
`reconcile_interrupted_runs` already own that lifecycle.

**Reload safety.** `uvicorn --reload` and the Electron dev flow both run a
single process with no workers, so exactly one scheduler exists. Worth a comment
in the module: adding `--workers > 1` later would multiply the loop and needs a
lock before that happens.

## 5. API

New router `backend/app/api/schedules.py`, registered in `backend/app/main.py`
(import list at `:13`, include loop at `:120`). Conventions follow
`backend/app/api/env_vars.py`; schemas go in
`backend/app/schemas/schedule.py` following `backend/app/schemas/env_var.py`
(`Create` / `Read` / `Update`, with `UTCDatetime` from `_types`).

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/schedules` | Optional `?workspace_id=`. `Read` includes computed `next_fire_at`, `last_fired_at`, and last outcome. |
| `POST` | `/api/schedules` | Validates cron + timezone; computes `next_fire_at`. |
| `GET` | `/api/schedules/{id}` | |
| `PATCH` | `/api/schedules/{id}` | Recomputes `next_fire_at` when `cron`, `timezone` or `enabled` change. |
| `DELETE` | `/api/schedules/{id}` | Leaves already-created threads intact (their `schedule_id` dangles harmlessly; the history rows go). |
| `POST` | `/api/schedules/{id}/run-now` | Fires immediately without touching `next_fire_at`. Returns `{thread_id}` so the UI can navigate straight into the streaming conversation. 409 if that schedule already has a live run. |
| `GET` | `/api/schedules/{id}/runs` | History, newest first, capped. Each row carries `thread_id` + `status` so the UI can link through. |
| `POST` | `/api/schedules/preview` | Body `{cron, timezone}` → the next 5 occurrences as ISO strings. Powers live feedback in the form; a cron expression is unreadable and this is the cheapest way to make one trustworthy. |

Validation, all returning 422 with a usable message rather than a 500:

- `cron` parses under `croniter` and is a 5-field expression.
- `timezone` resolves under `zoneinfo.ZoneInfo`.
- `workspace_id` / `agent_id` exist (mirrors `create_thread`,
  `backend/app/api/threads.py:39`).
- `prompt` is non-empty.
- `run_type == goal` requires `success_criteria` (or defaults it to the prompt,
  matching how `condition` falls back in `chat.py:1276`).

## 6. Frontend

### 6.1 API module

`frontend/src/api/schedules.ts` following `frontend/src/api/env-vars.ts`: a
`schedulesApi` object, a `scheduleKeys` factory, and `useSchedules` /
`useSchedule` / `useCreateSchedule` / `useUpdateSchedule` / `useDeleteSchedule`
/ `useRunScheduleNow` / `useScheduleRuns` react-query hooks. Types land in
`frontend/src/api/types.ts` next to the existing resource types.

### 6.2 Route and nav

- `frontend/src/App.tsx`: `<Route path="schedules" element={<SchedulesPage />} />`.
- `frontend/src/components/layout/app-sidebar.tsx:113`: a `navItems` entry
  `{ to: "/schedules", label: "Schedules", icon: Clock }` (Phosphor, matching
  the others).

### 6.3 The page

`frontend/src/pages/schedules/schedules-page.tsx`, two-pane rail + detail
following `frontend/src/pages/env/env-page.tsx`: `ResizablePanelGroup` on wide
viewports, the detail side collapsing into a `Sheet` under `useBrowserBox`, and
the selection mirrored to the URL (`?schedule=<id>`) so a pane is deep-linkable.

- **Rail:** one row per schedule — name, enabled toggle, next fire as relative
  time (`timeAgo` in `app-sidebar.tsx:117` has the formatting precedent),
  workspace and agent name, and a marker for a schedule whose last outcome was
  `missed`, `skipped` or `error`.
- **Detail:** the form (name, description, workspace, agent, cron, timezone,
  prompt, run type, and — for `goal` — success criteria and max iterations),
  the live "next 5 fires" preview from `POST /schedules/preview`, a **Run now**
  button, and the run history with each row linking to
  `/workspaces/{ws}/chat?c={threadId}`.
- **Empty state:** `EmptyState` (`frontend/src/components/empty-state.tsx`).
- Cron input stays a plain text field with the occurrence preview beneath it. A
  visual cron builder is a lot of UI for a field most users will paste into;
  the preview is what makes it safe.

Per the UI rules: every text element gets `text-foreground` or
`text-muted-foreground`, no absolute colors, and the page uses the existing
`px-4 py-6 sm:px-0` layout rather than `container`.

### 6.4 Keeping the sidebar usable

A daily schedule produces ~30 threads a month. `GET /api/threads` grows an
optional `include_scheduled=false` default so the sidebar's per-workspace
conversation list shows only human-started threads, and the Schedules page is
where scheduled runs are browsed. A scheduled thread opened by link still works
normally in the chat surface — it is an ordinary `Thread`.

### 6.5 Notifications (minimal)

No notification center in this scope. Two cheap touches:

- The existing `sonner` toast when a `run-now` launches.
- The sidebar's existing running-badge + unread affordance already covers "a
  scheduled run finished and you haven't looked at it", since
  `_persist_message` bumps `thread.updated_at` (`backend/app/api/chat.py:362`)
  and threads sort by recency.

Native OS notifications from `frontend/electron/main.cjs` are listed in §9.

## 7. Testing

`backend/tests/` (pytest-asyncio, `asyncio_mode = "auto"`).

- **Cron arithmetic, no DB:** next-occurrence across a DST spring-forward and
  fall-back in a non-UTC zone; elapsed-occurrence counting for the missed-fire
  rollforward; the 100-occurrence cap.
- **Validation:** malformed cron and unknown timezone both 422.
- **Tick behaviour with a fake clock and a stubbed launcher:** a due schedule
  launches once and only once; a disabled one never does; a schedule whose
  previous run is live records `skipped`; a launcher that raises produces an
  `error` row and does not stop the loop.
- **Startup pass:** a schedule with a past `next_fire_at` produces one `missed`
  row with the right count and a future `next_fire_at`, and launches nothing.
- **Launch path, real DB, stubbed model:** `start_scheduled_run` creates the
  thread, persists a `kind="cron"` user message, and registers with
  `chat_run_manager`. This is the test that catches a regression in the §3
  refactor.
- **Endpoint parity:** the existing chat tests must pass untouched. If any test
  needs editing to accommodate the refactor, that is a signal the refactor
  changed behaviour it should not have.

## 8. Build order

Each step is independently reviewable; nothing after step 1 is user-visible
until step 5.

1. **Models + migration.** `Schedule`, `ScheduleRun`, `Thread.schedule_id`, the
   one `ALTER`. Nothing reads them yet.
2. **The §3 refactor.** `launch_run` extraction plus `start_scheduled_run`, with
   the existing chat/plan/goal tests green and unmodified. Reviewed on its own,
   because it is the only step that can break something that works today.
3. **Cron utilities + `croniter` dependency.** Pure functions
   (`next_fire`, `elapsed_occurrences`, `validate_cron`) and their tests.
4. **Scheduler loop + lifespan wiring.** Firing works, driven by rows inserted
   by hand.
5. **API router + schemas.**
6. **Frontend api module, route, nav, page.**
7. **README** feature bullet and a `docs/` status line on this doc.

## 9. Deliberately not in this plan

- **An always-on daemon.** A launchd/systemd agent that keeps the backend alive
  outside the desktop app would make schedules fire with the laptop shut, but it
  fights the current design where Electron owns the backend process
  (`frontend/electron/main.cjs`) and it needs its own install/uninstall story in
  `docs/INSTALL.md` and `scripts/install.sh`. Separate plan.
- **Catch-up fires.** Decision 3 skips them. If a "must eventually run" job
  turns out to be needed, it is a `catch_up` boolean on the row and one branch
  in the startup pass.
- **Non-cron triggers.** File-change, git-push and webhook triggers all want the
  same launch path this plan builds; the `Schedule` row would grow a
  discriminated `trigger` instead of a bare `cron`. Worth keeping in mind when
  naming things, not worth building now.
- **Chained schedules.** "Run B when A completes" needs a completion hook and a
  dependency graph.
- **Per-schedule model override.** A schedule uses its agent's model. If
  scheduled runs want a cheaper model than interactive ones, that is a field on
  the row and a plumb into `_build_agent_and_context`.
- **Native OS notifications** on completion, via `frontend/electron/main.cjs`.
- **Concurrency across schedules.** Ten schedules due at midnight will all
  launch at once. The per-thread guard prevents self-stacking but there is no
  global cap; add one if it bites.

## 10. Open risks

1. **The §3 refactor is the whole risk surface.** `chat()` is 410 lines with
   four intertwined turn intents and a lot of hard-won comments about why each
   ordering is what it is (message withdrawal on build failure, session close
   before the stream, lifecycle stripping). Mitigation: extract only the driver
   construction and launch, change no ordering, and require the existing tests
   to pass unmodified.
2. **`chat.py` grows again.** It is already ~1600 lines and this adds to it.
   Moving the run engine out of `app/api/` into `app/agents/` is the right
   follow-up, but bundling that move into this feature would make the diff
   unreviewable. Noted as debt, deliberately deferred.
3. **Unattended spend.** A goal schedule with 25 max iterations on an expensive
   model, firing hourly, is real money with nobody watching. Mitigations in
   scope: `chat` is the default run type, `max_iterations` is on the form with
   the default visible, per-turn `TURN_REQUEST_LIMIT` still applies, and usage
   rows are tagged `"cron"` so Analytics can break scheduled spend out. Not in
   scope: a budget ceiling that disables a schedule.
4. **Unattended writes.** A scheduled agent has the same filesystem and shell
   reach as an interactive one, in a workspace nobody is looking at. That is the
   feature, but it deserves a line in the UI: the form should say plainly that
   the run has full agent tooling in that workspace.
5. **Clock changes.** Laptop sleep, timezone changes while running, and NTP
   jumps all mean `next_fire_at` can be stale in either direction. Recomputing
   forward from `now()` after every fire (rather than from the scheduled slot)
   makes a late tick fire once instead of catching up silently.

## 11. What actually shipped, and where it differs

Everything in §1–§8 landed. Five deliberate deviations, each because building it
surfaced something the plan hadn't accounted for.

1. **The §3 refactor is narrower than proposed** — and that was the point of
   calling it the whole risk surface (§10.1). Rather than a `launch_run(session,
   *, thread, agent_row, workspace, adapter, turn, ...)` that owns driver
   *construction* for all five turn intents, the extraction is:

   - `run_chat_turn(...)` — the former `chat_driver` closure's body, at module
     level.
   - `_run_goal_execution(..., kind=...)` — already module level; gained one
     parameter so a fire can tag its usage `"cron"`.
   - `launch_run(thread_id, workspace_id, backend, driver)` — the two things that
     happen around *every* run: preview registration, then the detached spawn.

   `plan_driver` was left in the endpoint untouched, because a schedule can never
   run plan mode (decision 2) — extracting it would have been pure regression risk
   against zero benefit. The endpoint keeps all of its request parsing and every
   ordering comment. The existing 387 tests pass unmodified, which was the bar
   §7 set.

2. **Deleting a schedule clears `schedule_id` on its threads.** §5 said the id
   "dangles harmlessly". It doesn't: §6.4 hides any thread carrying one from its
   workspace's conversation list, and the Schedules page is the only other place
   they are browsed — so a dangling id would make every run a deleted schedule ever
   produced unreachable outside a saved URL. Clearing it hands them back to the
   workspace as ordinary conversations, which is what they now are.

3. **`Schedule.next_fire_at` is null while disabled**, rather than holding a stale
   future instant. Otherwise re-enabling a schedule that had been off for a week
   would read as a pile of missed fires on the next restart.

4. **`POST /schedules/{id}/run-now` returns the whole `ScheduleRun`**, not just
   `{thread_id}`. It costs nothing and lets the UI show the same history row it just
   created. It also answers 502 (not just 409) when the launch itself fails, so a
   broken agent config is reported at the moment you test it rather than only in
   the history list.

5. **System workspaces are excluded from the schedule pickers.** The Skill Studio
   (`Workspace.is_system`) sorts first among workspaces, so it silently became the
   default target for every new schedule — which is never what anyone means by
   standing work. Existing schedules pointed anywhere still render their
   workspace's real name.

Two smaller notes:

- `app/cron.py` takes its reference instant as an argument everywhere, with no
  wall-clock read of its own. That is what makes the DST and closed-for-a-weekend
  cases in §7 ordinary assertions.
- `host_timezone()` resolves the IANA name from `TZ` then the `/etc/localtime`
  symlink. `datetime.now().astimezone().tzinfo` — the obvious call — yields an
  abbreviation (`EDT`) that `ZoneInfo` rejects, which would have silently defaulted
  every schedule to UTC.

## 12. The visibility hole in §6.4 / §6.5

Found by running a real schedule: it fired correctly and there was nowhere to see
it. §6.4 and §6.5 contradict each other, and building both as written produced a
run you could not reach.

§6.4 hides any thread carrying a `schedule_id` from its workspace's conversation
list. §6.5 then claims "the sidebar's existing running-badge + unread affordance
already covers 'a scheduled run finished and you haven't looked at it'" — but that
affordance *is* the sidebar's conversation list, which §6.4 just removed the thread
from. Three concrete consequences, all now fixed:

1. **`Run now` went nowhere.** §5 says run-now returns `thread_id` "so the UI can
   navigate straight into the streaming conversation". It was returned and then
   only toasted, so testing a schedule produced no observable result at all. It now
   navigates into the conversation, which is the whole point of pressing it.

2. **The only way into a scheduled transcript was an unlabelled 14px icon.** The
   whole history row is now the link, with a visible "Open", under one line saying
   where those conversations live.

3. **Opening one by link showed the wrong thread state.** `workspace-chat-page`
   resolves the open conversation with `threads.find(...)` over the *workspace
   list* — which §6.4 filters. So a scheduled thread rendered the "New
   conversation" placeholder instead of its title, offered no rename, and left the
   composer's agent picker on the default rather than the agent that ran it (a
   follow-up message would have run under the wrong agent). It now falls back to
   `useThread(id)`, which is unfiltered. `GET /threads/{id}` staying unfiltered is
   now asserted in `test_scheduler.py`.

Still true, and worth a follow-up plan rather than a patch here: **there is no
ambient signal that a scheduled run finished.** §6.5's mechanism does not exist for
these threads, so the Schedules page is the only place a completed overnight run
shows up — you have to go looking. An unread count on the Schedules nav item, or the
native OS notification already listed in §9, would close it.
