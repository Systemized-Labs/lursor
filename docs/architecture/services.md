# Long-lived services: schedules, preview, terminals, browser QA

The four subsystems that outlive a turn, plus the smaller per-workspace surfaces.
Indexed from [`AGENTS.md`](../../AGENTS.md) §6.

## Schedules

`Schedule` + `ScheduleRun` rows, an in-process 30s `asyncio` tick
(`agents/scheduler.py`, modelled on `preview_service._poll_loop`), and
`chat.start_scheduled_run` — the headless counterpart to the chat endpoint. Both
converge on the same drivers, so a scheduled run can't drift from a manual one.

- **New thread per fire.** No unbounded context growth; each run's transcript,
  todos, diff and usage stand alone.
- **Missed fires are reported, never replayed.** A schedule whose `next_fire_at`
  is in the past gets one `missed` history row with the elapsed count and rolls
  forward. Opening the app after a weekend must never launch a burst of billable
  runs. `next_fire_at` is null while disabled, so re-enabling doesn't read as a
  pile of missed fires.
- **One run per schedule at a time** (`skipped` row otherwise).
- Timezone is an IANA name on the row; `zoneinfo` does the arithmetic, so 9am
  survives DST. `host_timezone()` reads `TZ` then the `/etc/localtime` symlink —
  `datetime.now().astimezone().tzinfo` yields an abbreviation (`EDT`) that
  `ZoneInfo` rejects, which would silently default every schedule to UTC.
- `app/cron.py` takes its reference instant as an argument everywhere and never
  reads the clock, which is what makes DST and closed-for-a-weekend ordinary
  assertions.
- `next_fire_at` rolls forward from **now**, not from the missed slot, so a slow
  tick fires once instead of catching up silently.
- Only one process, no workers — adding `--workers > 1` would multiply the loop
  and needs a lock first.
- Usage rows are tagged `kind="cron"` so unattended spend is visible in
  Analytics. Plan mode is not offered: a schedule that parks a doc nobody
  approves is a trap.
- Deleting a schedule **clears `schedule_id`** on its threads, handing them back
  to the workspace as ordinary conversations — a dangling id would make every
  run it ever produced unreachable.
- `GET /threads/{id}` stays unfiltered (asserted in `test_scheduler.py`): the
  chat page falls back to it, because resolving a scheduled thread against the
  filtered workspace list rendered the wrong state and the wrong agent.

Still open: there is no ambient signal that an overnight run finished. The
Schedules page is the only place it shows up.

## Preview and background processes

Detection **must not** ride the chat run. The first cut did, and lost: the dev
server outlives the turn and the chat SSE closes on `RUN_FINISHED`.

`agents/preview_service.py` is a long-lived per-workspace service. The chat
endpoint `register(workspace_id, backend)`s each run's backend; a poll loop scans
retained backends, parses candidate URLs (`preview_detect.parse_server_url`),
probes readiness over HTTP, and broadcasts **full snapshots** over
`WS /api/workspaces/{id}/preview/ws`. The panel keeps that socket open regardless
of chat activity.

- It tracks *all running background processes*, not just servers — a server is
  just a process that advertised a URL and passed the probe.
- Keep the most-recently-registered backend even while idle. `register` runs at
  run start, before the agent calls `run_in_background`; pruning on an empty
  first scan released the backend the dev server was about to appear in.
- First ready server auto-opens the panel once; further servers are one-tap
  chips, and a panel the user closed is not re-popped.
- `RunningProcessesBar` sits above the composer with inline output; the
  right-dock `process` panel and its pub/sub plumbing were removed as a
  duplicated surface for a read-only log tail.
- Process tracking is in-memory per backend, so a backend restart orphans
  still-running servers (they keep running, untracked). psutil-based
  rediscovery stays deferred.

## Terminals — the shell outlives its socket

`app/terminal_sessions.py` owns the PTY; `api/terminal.py` is only the display
transport. A terminal's shell used to live and die with its WebSocket, so
switching workspaces — which calls `fromJSON` and rebuilds every panel — killed
it, and coming back spawned a new shell in the default directory with no history
and no running processes. A page reload did the same. `renderer: 'always'`
protects a terminal from a *pane* move but not from a *workspace* switch.

The fix is an identity (the pane id) and an owner that outlives any one
connection. The registry forks the shell, keeps the master fd's reader installed
for the session's whole life, and accumulates output into a bounded ring
(`_BUFFER_CAP`, 512 KB ≈ 5k lines, trimmed at a line boundary). A client
**attaches** by `session_id`, replaying the ring so the pane comes back looking
the way it left; it **detaches** without killing anything; and only a real pane
close — `DELETE /api/terminal/sessions/{id}` — or the idle sweeper reaps the
child. `_TERM_GRACE` between `SIGTERM` and `SIGKILL` is what lets zsh finish
saving its history.

A socket that cannot name its pane (`session_id` omitted) still gets a terminal;
it is just **ephemeral**, reaped on disconnect like the old behaviour.

**One pre-warmed shell per workspace.** An interactive shell costs whatever the
user's rc files cost — measured at ~1.8s for a plain `zsh -i` — and all of it is
paid before the first prompt is painted, so the panel reads as hung. `POST
/api/terminal/prewarm` starts one in the background when a workspace opens
(`use-terminal-prewarm.ts`, one request per workspace per browser session; the
backend is idempotent anyway), and the first click on Terminal claims a shell
already sitting at its prompt. Fire-and-forget in every sense: a failure, an old
backend without the endpoint, or a workspace nobody opens a terminal in all cost
nothing beyond the shell being reaped by `_WARM_TTL`. The prewarm carries the
geometry the last terminal settled at, so the prompt is not printed at 80×24 and
reflowed the instant a real pane attaches.

Two TTLs, deliberately different: `_IDLE_TTL` (30 min) for a detached session
someone may come back to, `_WARM_TTL` (10 min) for an unclaimed pre-warmed shell
nobody has asked for yet. `_MAX_SESSIONS` (32) caps the lot. In-memory only — a
backend restart takes the app down with it, so there is nothing worth persisting.
Modelled on `preview_service`: module-scope state, a lazily started sweeper that
retires when there is nothing left to watch, TTL pruning. POSIX only
(macOS/Linux). Deliberately *not* env-injected.

`components/shell/terminal-cache.ts` is the client half: live xterm instances
parked beyond the lifetime of the React component that shows them, keyed by pane
id. The backend keeping the shell alive is what makes a terminal survive a
*reload*; caching the client is what makes a workspace switch cost nothing at all
— no socket, no replay, no re-render, and scroll position, selection and
alt-screen state preserved exactly. `MAX_LIVE` (8) bounds it by LRU; an evicted
entry only loses its client, since the shell behind it is still re-attachable.

## Browser visual QA

`agents/browser_qa.py` **composes** pydantic-deep's `BrowserCapability` rather
than using it directly: upstream `screenshot` returns text-only base64 (the model
cannot actually see it) and it captures no console or network. So we reuse the
vendored driving toolset (navigate/click/type/…) and own the browser lifecycle to
add `view_app` (screenshot → vision model) plus `get_console_logs` /
`get_network_errors`.

Python Playwright, no Node. Chromium auto-installs on first use (~150 MB, once).
Per-run, headless, `allowed_domains` scoped to loopback. `screenshot_url` is the
standalone path the goal evaluator uses, since the capability is run-scoped and
agent-driven.

## The smaller surfaces

- **Files** — `api/files.py` + a per-workspace watcher; Monaco, lazily loaded,
  fully editable on mobile with touch-tuned options. Tree rows carry VS Code-style
  git decorations from `GET /git/status` — deliberately *not* `/git/diff`, which
  computes a patch per changed file; the tree needs a state per path and nothing
  else. Changes roll up onto collapsed folders (`lib/git-tree-status.ts`), and
  `--ignored=matching` is what keeps the ignored set one entry per wholly-ignored
  directory instead of one per file inside `node_modules`. The panel itself is in
  [`frontend-shell.md`](frontend-shell.md).
- **Git / GitHub** — `api/git.py` returns `is_repo=False` for a non-repo
  (the skills catalog) and the panel renders its empty state. `api/github.py`
  holds the token server-side.
- **Prompt library** — `PromptTemplate` rows, seeded idempotently on every boot
  (`db/prompt_seed.py`). A template is **copied into** `Agent.instructions`, not
  linked, so agents stay self-contained. `agents/prompt_author.py` generates and
  improves prompts, capability-aware: it only references tools the agent
  actually has.
- **Analytics** — `UsageRecord` rows per turn, tagged with a `kind`, rolled up by
  model / workspace / day.
- **Models** — OpenRouter by default (`openrouter:` prefix), plus
  `CustomProvider` rows for OpenAI-compatible endpoints, including ones with no
  `/v1/models` (manual model lists).
