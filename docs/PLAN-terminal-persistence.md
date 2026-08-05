# Persistent, fast-attaching terminals

## Context

Two complaints, one root cause each.

**"Leave the workspace and come back, it's a fresh terminal."**
The PTY's lifetime is the WebSocket's lifetime. `backend/app/api/terminal.py:146` calls
`_reap(pid)` — `SIGKILL` + `waitpid` — in the `finally` of the socket loop, and the WS
endpoint takes only `workspace_id`, so there is no session identity to reattach to even
if the process survived. On the frontend, switching workspaces makes `usePaneLayout.load`
call `api.fromJSON(...)` (`use-pane-layout.ts:290`), which removes every panel of the
outgoing workspace and rebuilds them. `TerminalPanel`'s effect cleanup closes the socket,
the backend reaps the shell, and coming back spawns a brand-new one. `renderer: 'always'`
protects a terminal from a *pane* move but not from a *workspace* switch, and nothing
protects it from a page reload.

**"It takes several seconds to render."**
Measured on this machine: `zsh -i -c exit` is **1.78s**. Nothing is painted until the rc
files finish and the prompt is written, and the panel is blank the whole time — so the
wait reads as a hang. Add the lazy `pane-host` chunk (which carries xterm), the WS
handshake, and a DB round-trip in `_resolve_cwd`, and it's several seconds every time.

**Outcome:** a terminal pane reattaches to the shell it had — same cwd, same history, same
running process — across pane moves, workspace switches, and page reloads. First open of a
workspace's terminal is near-instant because the shell was already started in the
background. Sessions are in-memory (they die with the backend, which is fine — a restart
kills the app anyway) and are reaped on real pane close or after an idle timeout.

Decisions taken (confirmed): in-memory registry with idle TTL; pre-warm one shell per
workspace; sessions keyed by **pane id**, so two terminal tabs stay independent — matching
today's "each mounted instance is its own shell" contract.

## Approach

### 1. Backend: a session registry that owns PTYs (new `backend/app/terminal_sessions.py`)

Model it on `backend/app/agents/preview_service.py` — module-scope state, keyed dict,
one background sweeper, TTL pruning — and on the `_workspace_backends` registry at
`backend/app/agents/builder.py:131`. Sits at `app/` level (like `app/media_store.py`)
because it owns process lifetime, not HTTP.

A `_Session` dataclass holds: `id`, `workspace_id`, `cwd`, `pid`, `master_fd`, a
`bytearray` scrollback ring, `cols`/`rows`, `attached: bool`, `detached_at: float | None`,
`exited: bool`, and the current output subscriber queue.

- **Reader always on.** `loop.add_reader(master_fd, ...)` is installed when the session is
  *created*, not when a client attaches — that is what lets a detached shell keep making
  progress and lets a pre-warmed one reach its prompt. Every chunk appends to the ring and,
  if a client is attached, goes to its queue.
- **Ring buffer, trimmed at line boundaries.** Cap ~512 KB. Trimming mid-escape-sequence
  would corrupt the replay, so drop whole `\n`-delimited chunks from the front.
- **`attach(session_id, cols, rows)`** returns the ring's contents for replay, marks the
  session attached, and applies the winsize. Applying winsize *after* replay is load-bearing:
  the `TIOCSWINSZ` raises `SIGWINCH`, which makes a full-screen app (vim, htop) redraw itself
  — the one case raw replay can't reconstruct.
- **`detach()`** flips `attached = false` and stamps `detached_at`. It does **not** kill.
- **`release(session_id)`** is the explicit kill, for a pane the user actually closed. Reuses
  the existing `_reap` (`terminal.py:159`).
- **Sweeper** — one `asyncio` task, ~30s tick: reap sessions detached longer than
  `_IDLE_TTL` (30 min), pre-warmed-and-never-claimed longer than `_WARM_TTL` (10 min), and
  any whose child has exited and been drained. LRU-evict detached sessions past a cap
  (`_MAX_SESSIONS = 32`) so a long-lived backend can't accumulate shells.
- **`prewarm(workspace_id, cwd, cols, rows)`** creates an unclaimed session for that
  workspace if one isn't already waiting. Claimed by the next attach for a session id that
  doesn't exist yet *and* whose `workspace_id` matches.

`_spawn_shell` and `_set_winsize` move here from `terminal.py` unchanged.

### 2. Backend: `terminal.py` becomes transport only

- `GET /terminal/ws` gains a `session_id` query param (the pane id). Resolve cwd, then
  `attach` — reusing an existing session, claiming a pre-warmed one, or creating a new one.
  Send the replay buffer as one binary frame before entering the pump loop.
- Distinguish **shell exited** from **socket dropped**. Today `ws.onclose` unconditionally
  prints `[process exited]` (`terminal-panel.tsx:123`), which would be a lie on every
  reconnect. Send a text control frame `{"type":"exit"}` before closing when the child is
  actually gone; a bare close means "reconnect".
- Client→server control frames gain nothing new; `resize` keeps working but now also
  updates the session's stored `cols`/`rows`.
- `POST /terminal/prewarm?workspace_id=…&cols=…&rows=…` → `204`. Idempotent.
- `DELETE /terminal/sessions/{session_id}` → `204`. Explicit kill; 204 on unknown id too.
- `main.py`'s `lifespan` (`backend/app/main.py:92`, beside `scheduler.stop()`) reaps every
  live session on shutdown so nothing is orphaned.

### 3. Frontend: reattach instead of respawn (`terminal-panel.tsx`)

- Take a `paneId` prop and pass it as `session_id`. `pane-content.tsx:86` already has
  `paneId` in scope — one-line change.
- **Auto-reconnect** with capped exponential backoff (250ms → 4s) on any close that wasn't
  preceded by an `exit` control frame, plus an immediate retry on `online` and on
  `visibilitychange → visible`. Print `[process exited]` only on a real exit.
- Persist last-known `cols`/`rows` under `tabStorageKey(paneId, "size")`
  (`frontend/src/lib/tab-storage.ts`) and send them on the prewarm call, so the warm shell's
  first prompt isn't printed at 80×24 and then reflowed.
- Show a dim `connecting…` line immediately on mount rather than a blank panel, cleared by
  the first byte. Cheap, and it removes most of the *perceived* wait on a genuinely cold
  session.

### 4. Frontend: keep the live xterm instance across mounts (new `terminal-cache.ts`)

Backend replay alone still costs a WS round-trip plus a full re-render on every workspace
switch. A module-level `Map<paneId, {term, fit, ws, el}>` where `el` is the detached host
div makes it free: on mount, append the cached `el` and call `fit.fit()`; on unmount, detach
the node and leave the socket open. Scroll position, selection, and alt-screen state survive
exactly, with no replay at all.

- Cap at 8 entries, LRU-evicted (dispose the `Terminal`, close the socket — the backend
  session survives and is reattachable).
- Eviction on real close is wired in `use-pane-layout.ts:371`'s `onDidRemovePanel`, which
  already distinguishes a close from a workspace-switch unload via `loading.current`. The
  non-loading branch (next to `clearTabStorage`) drops the cache entry **and** fires
  `DELETE /api/terminal/sessions/{id}`. The idle TTL is the backstop for anything that
  slips through (closing the tab, a crash).

### 5. Frontend: pre-warm on workspace open (new `hooks/use-terminal-prewarm.ts`)

A `useEffect` keyed on `workspaceId` that POSTs `/terminal/prewarm` once per workspace per
session, called from `app-shell.tsx` where `workspaceId` is already known. Fire-and-forget;
a failure just means the old cold-start behaviour. This is what turns the 1.78s rc load into
something already paid by the time the user clicks Terminal.

## Files

**New**
- `backend/app/terminal_sessions.py` — the registry, ring buffer, sweeper, prewarm/release
- `backend/tests/test_terminal_sessions.py`
- `frontend/src/components/shell/terminal-cache.ts`
- `frontend/src/hooks/use-terminal-prewarm.ts`

**Modified**
- `backend/app/api/terminal.py` — `session_id` param, attach/replay, `exit` control frame,
  prewarm + release endpoints; `_spawn_shell`/`_set_winsize` move out
- `backend/app/main.py` — reap sessions in `lifespan` shutdown
- `frontend/src/components/shell/terminal-panel.tsx` — `paneId` prop, reconnect, cache, size persistence
- `frontend/src/components/panes/pane-content.tsx:86` — pass `paneId`
- `frontend/src/components/panes/use-pane-layout.ts:371` — release the session on real close
- `frontend/src/components/layout/app-shell.tsx` — call the prewarm hook

## Non-goals

- **tmux backing.** Rejected above; sessions die with the backend, and that's the right trade.
- **`@xterm/addon-webgl`.** A paint-throughput improvement, orthogonal to both complaints.
  Worth revisiting separately if scrolling a busy build log feels slow.
- **Trimming `$SHELL -i`.** The rc cost is the user's own config; pre-warming hides it rather
  than fighting it.

## Verification

Backend (`cd backend && uv run pytest tests/test_terminal_sessions.py -v`):
- attach → detach → attach returns the same pid and replays the ring
- the ring trims at a line boundary and never exceeds the cap
- a session detached past the TTL is reaped by the sweeper; an attached one never is
- `release()` kills the pid and drops the entry; a second `release()` is a no-op
- a pre-warmed session is claimed by the first matching attach, and reaped by `_WARM_TTL`
  if never claimed
- child exit surfaces `exited = True` and the socket closes with an `exit` frame

Manual, end to end (`bun run dev` in `frontend/`, `uv run uvicorn app.main:app --reload` in
`backend/`):
1. Open a workspace terminal, run `cd /tmp && export MARK=1`, start `top`.
2. Switch to another workspace and back → `top` is still running, same frame. Should be
   visually instant (cache hit), not a reconnect flicker.
3. Hard-reload the page → the pane reattaches, `echo $MARK` prints `1`, scrollback replayed,
   `top` redraws via the `SIGWINCH` on attach.
4. Resize the pane while detached (collapse the bottom row, switch workspace, come back) →
   no mangled reflow.
5. Close the terminal pane → confirm the shell is gone (`ps` shows no orphan) and
   `lursor:tab:<paneId>:*` is cleared.
6. Open a fresh workspace, wait a beat, click Terminal → prompt appears immediately.
7. Kill the backend → the panel shows reconnect attempts, not `[process exited]`; restart it
   → a new shell is created cleanly.
