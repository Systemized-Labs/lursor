# PLAN: Preview auto-detect — dev servers that just appear

> Status: **IMPLEMENTED (v2).** First cut tied detection to the chat run, which
> was fundamentally wrong — the dev server outlives the turn, and the chat SSE
> closes on `RUN_FINISHED`, so detection raced the end of the turn and usually
> lost. Reworked into a **long-lived per-workspace `PreviewService`** exposed
> over its own WebSocket (`/api/workspaces/{id}/preview/ws`) that the Preview
> panel subscribes to independently of chat. Two decisions changed from user
> testing (see below). Backend suite (75) and frontend `tsc`/`oxlint` pass.

## Goal

When an agent (or the user) starts a dev server in a workspace, the **Preview
panel should light up on its own** — correct URL, correct port, and only once the
server is actually serving — instead of the user guessing a port from a hardcoded
chip list and manually reloading an iframe until the connection error goes away.

Target flow, end to end:

1. User: "run the app so I can see it."
2. Agent starts the server **non-blocking** and keeps working.
3. Backend detects the port, waits until the server answers HTTP, and pushes a
   `preview` event to the chat stream.
4. Preview panel shows a chip — *"Dev server ready on :5173 → Open preview"* —
   and (first server only) auto-opens + auto-reloads the iframe when ready.
5. Manual URL entry and "open externally" stay as fallbacks.

## Key finding (de-risks this)

The capability already exists; only the **wiring to the UI** is missing.

- The agent runs on `pydantic-ai-backends`, whose console toolset already ships
  `run_in_background` / `read_output` / `kill_shell` / `list_shells`. The
  `run_in_background` description is written for exactly this ("dev servers,
  watchers, `uvicorn`/`npm run dev`… Do NOT use plain `execute` for servers").
- This is the same mechanism a competitor described (a shell started with
  `block_until_ms: 0`, then poll the log for the ready line). We don't need a new
  tool shape — we need to *close the loop around* the one we have.
- The chat stream already carries a custom AG-UI event (`todos`) encoded as an
  SSE line through `chat_run_manager`, which buffers and **replays on reconnect**.
  A new `preview` event rides the same path, so it's delivered on both the live
  and reconnect transports for free.

## Current state (what's there today)

- `frontend/src/components/shell/preview-panel.tsx` — iframe + address bar.
  Port discovery is `const COMMON_PORTS = [3000, 5173, 8000, 8080]` (guesswork).
  Reload = remount iframe via key bump. No readiness detection.
- `frontend/src/lib/open-preview.ts` — module-level pub/sub; the only automatic
  "open this URL" path today, triggered by right-clicking a chat link.
- `backend/app/api/chat.py` — `_encode_todos_event` / `CustomEvent` pattern; the
  template for a new stream event.
- `backend/app/agents/chat_run_manager.py` — buffers encoded SSE lines
  (`_buffers`), replays on subscribe. Any event encoded here is reconnect-safe.
- `backend/app/api/terminal.py` — the user's PTY shell (separate process space
  from the agent's background shells).

### Pain points being fixed
1. No bridge from a started server to the Preview.
2. Hardcoded port guessing; no handling of Vite bumping 5173→5174.
3. No readiness detection → connection-error-then-manual-reload dance.
4. Agent-started and terminal-started servers invisible to the UI.

## Architecture

Three layers, shippable independently, cheapest first.

```
 agent run_in_background ─┐
                          ├─→ [detector]  port + readiness  ──→ CustomEvent "preview"
 user PTY terminal ───────┘        (backend)                    (chat SSE, replay-safe)
                                                                        │
                                                          preview-panel subscribes
                                                          → chip / auto-open / auto-reload
```

### Layer 1 — Agent behavior (prompt/skill)

Make the agent reliably use `run_in_background` for servers and report the URL.

- Add a short block to the system prompt (via `backend/app/agents/builder.py`)
  and/or a "run the dev server" skill: start servers with `run_in_background`,
  never blocking `execute` (which reaps the process on its 120s timeout), then
  state the URL it printed.
- This alone reaches parity with the competitor's described behavior.

### Layer 2 — Detection + `preview` stream event (backend)

**Port detection (MVP: log-parse).** Scan the background shell's captured stdout
for a ready/URL line. Patterns to match (case-insensitive), first hit wins:
- `Local:` / `➜  Local:` followed by `http://…:<port>` (Vite)
- `http://localhost:<port>` / `http://127.0.0.1:<port>` / `http://0.0.0.0:<port>`
- `listening on (port )?<port>`, `running at .*:<port>`

Normalize `0.0.0.0`/host-bind to `127.0.0.1` for framing.

**Readiness probe (backend-side).** Once a candidate URL is found, poll it with a
short-timeout `GET` (httpx) until it answers (any HTTP status = ready; connection
refused = not yet). The backend can reach `localhost` even when the cross-origin
iframe can't report load state. Cap total wait (~30s) and back off.

**Emit `preview` CustomEvent.** Mirror `_encode_todos_event` in `chat.py`:
```
CustomEvent(type=CUSTOM, name="preview",
            value={"url": "http://127.0.0.1:5173", "port": 5173,
                   "status": "starting" | "ready", "source": "agent" | "terminal"})
```
Emit `starting` on first detection, `ready` when the probe succeeds. Encode via
the same SSE helper so `chat_run_manager` buffers + replays it. **Explicitly
verify both the live-send and reconnect paths** carry it (this repo has been
bitten by events wired into only one).

**Where the detector runs.** In the chat run loop, snapshot the agent's
background-shell output after streamed events (same cadence as the todos
snapshot) and run the parser/probe out-of-band so it never blocks the token
stream. A single probe task per detected candidate.

**Optional robustness (later): psutil PID→port.** Add `psutil` (not currently a
dep), map the tracked child PID + descendants to listening TCP ports. Precise,
framework-agnostic, and also covers the user's PTY terminal (fixes pain #4).
Deferred behind the log-parse MVP.

### Layer 3 — Preview panel UX (frontend)

- Subscribe to `preview` events in the stream reader (where `todos` is handled);
  keep a per-workspace list of detected servers `{url, port, status, source}`.
- Replace the hardcoded `COMMON_PORTS` chips with the live detected-servers list.
  Keep a manual URL input as fallback.
- Show a chip/toast: *"Dev server ready on :5173 → Open preview."*
- **First ready server auto-opens** the dock + preview tab (reuse
  `open-preview.ts`), and the iframe **auto-reloads** (key bump) when a server's
  status flips `starting → ready` — killing the manual-reload dance.
- Preserve "open externally" for pages that send `X-Frame-Options`.

## Changes by file

### Backend
- `app/api/chat.py` — add `_encode_preview_event`; snapshot background-shell
  output per streamed event; run parse + readiness probe; emit `preview`.
- `app/agents/preview_detect.py` (new) — URL/port regexes + `httpx` readiness
  probe. Pure/testable.
- `app/agents/builder.py` — system-prompt guidance to prefer `run_in_background`
  for servers and report the URL. (Or a new skill under the skills store.)
- `chat_run_manager.py` — no change expected (rides existing encoded-line buffer);
  confirm during impl.

### Frontend
- `agui/v2/*` stream reader — handle `preview` custom event, push to store.
- `components/shell/preview-panel.tsx` — detected-servers list replaces
  `COMMON_PORTS`; auto-reload on `starting→ready`.
- `lib/open-preview.ts` — reuse for first-ready auto-open (likely no change).
- Store slice (zustand) for detected servers keyed by workspace.

### New deps
- Backend: none for MVP (`httpx` already present via FastAPI stack — confirm).
  `psutil` only if Layer 2's optional PID→port path is pursued.

## Testing / verification
- Unit: `preview_detect` regex table against real Vite / Next / uvicorn / CRA
  startup logs; readiness probe against a stub server.
- Integration: start a Vite app in a workspace via the agent → assert a
  `preview` event with the right port arrives, and again after reconnect
  (replay-path check).
- Manual: agent "run the app" → panel auto-opens on ready; Vite port bump
  5173→5174 reflected; kill server → chip clears/greys.

## Out of scope
- Docker/sandbox execution (deferred in PLAN.md).
- Multi-server orchestration UI beyond a simple list.
- Proxying/rewriting responses to defeat `X-Frame-Options`.

## Decisions
1. **Scope: agent servers only** — detect servers the agent starts via
   `run_in_background` (log-parse). Terminal-started servers stay manual; the
   psutil PID→port path is deferred. *(unchanged)*
2. **Auto-open: first ready server** — *changed from "always click" after user
   testing.* The user's request ("spin up the preview for me") and the agent's
   own phrasing set the expectation that it opens itself; leaving it click-only
   read as broken. So the first server to reach `ready` auto-opens the Preview
   panel; further servers stay one-tap chips, and once the user closes the panel
   it isn't re-popped. The iframe still auto-reloads on `starting→ready`.
3. **Feed: dedicated per-workspace WebSocket, not the chat stream** — *changed
   from "stream-derived via chat SSE".* Detection must outlive the chat run, so
   it can't ride the chat stream. The `PreviewService` polls each run's
   (retained) backend and streams full snapshots over a workspace WebSocket the
   panel keeps open regardless of chat activity. Still in-memory only (no
   `localStorage`); a refresh re-subscribes and the service replays the current
   snapshot.

### Running-process indicator (added after v2)
User asked for a permanent, visible handle on the agent's background processes —
not just the auto-preview. The `PreviewService` was generalized from "detected
servers" to "all *running* background processes" (a process with no served URL,
e.g. a `--watch` build, is still a live terminal worth showing). The same feed
now carries every running process; a server is just a process that advertised a
URL and passed the readiness probe.

- Backend: WS snapshot is `{processes: [{id, shellId, command, url, port,
  ready}]}`; added `GET …/preview/output?id=` (stdout+stderr tail, non-draining)
  and `POST …/preview/kill?id=` (`kill_background`, then rescan+broadcast).
- Frontend: `BackgroundProcessesIndicator` — a pill (terminal icon + count +
  pulsing dot) shown whenever ≥1 process runs, in both the RightDock tab strip
  and the collapsed DockRail so it's always present in a workspace. Click opens a
  panel: per-process command, live state (running / starting / ready), lazy
  output view with refresh, an Open-in-Preview shortcut for ready servers, and a
  Kill button. Hidden entirely when nothing runs. Desktop chrome only for now
  (mobile dock bar not wired).

### Moved: running-process indicator lives in the chat, not the dock
The dock rail/tab-strip pill was the wrong home. Replaced with a Cursor-style
card in the chat window, just above the composer:
- `RunningProcessesBar` (in the chat page) shows `N Terminal(s) Running` with
  each process's command and live elapsed time (ticks every second). Backend now
  sends `startedAt` (first-seen epoch, a close proxy for start time).
- Clicking a row **expands the process's read-only output inline** in the card.
  The output view polls `GET …/preview/output` while expanded and offers Kill +
  Open-in-Preview (the latter routes through the existing `open-preview` channel).

### Simplified: output lives inline in the chat card, not a separate dock panel
The right-dock `process` panel was overkill for a read-only log tail — it
duplicated a surface and needed a whole cross-component plumbing path. Removed:
the `process` dock kind, `ProcessOutputPanel`, the `open-process` pub/sub channel
(a clone of `open-preview`), and `useSelectedProcessStore`. The output view is now
a child of `RunningProcessesBar`, toggled by local state, so the drill-down is one
click with no dock/tab/store machinery. Open-in-Preview reuses `open-preview`.
The store module was renamed `preview-servers.ts` → `processes.ts` to match what
it now holds.

### Bug fix: register-before-start race
The indicator showed nothing because `register(workspace_id, backend)` runs at
*run start*, before the agent calls `run_in_background`. The first `_scan`
(≤1.5s later) saw the backend with zero processes and the `if not any_live:
drop` pruning released it — so the dev server the agent started seconds later
lived in an unregistered backend and was never detected. Fix: keep the
most-recently-registered backend (`latest_backend_id`) even while idle; only
prune *older* backends whose processes have all exited. Verified against a real
`LocalBackend` (register → scan empty → start server → detected). Note: process
tracking is in-memory per backend-process, so a backend restart orphans any
still-running servers (they keep running but go untracked) — rediscovery via
psutil stays deferred.

### Architecture (as built)
- `backend/app/agents/preview_detect.py` — pure helpers: `parse_server_url`,
  `read_background_stdout` (non-draining), `probe_ready`.
- `backend/app/agents/preview_service.py` — `PreviewService` singleton: chat
  endpoint `register(workspace_id, backend)`s each run's backend; a per-workspace
  poll loop scans all retained backends, parses/probes, and broadcasts full
  snapshots to subscribers. Backends are dropped once all their processes exit.
- `backend/app/api/preview.py` — `WS /workspaces/{id}/preview/ws`, sends the
  current snapshot on connect then every change.
- Frontend `use-preview-watch.ts` (mounted in the app shell) mirrors
  `useFileWatch`: connects, `replace`s the store per snapshot, auto-opens the
  first ready server. Panel renders chips + auto-reloads on ready.
