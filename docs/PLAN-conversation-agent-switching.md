# Plan — Switch conversations & agents at any time (swarmcore parity)

> Status: **IMPLEMENTED & VERIFIED** (2026-07-10). See "Verification" at the bottom.
> Goal: replace the navigation-based, one-thread-per-page chat with a single
> per-workspace chat surface where you can switch **conversations** and **agents**
> at any time, matching the UX of `~/work/swarmcore`.

## 1. Decisions (locked from kickoff Q&A)

| Question | Choice | Consequence |
|---|---|---|
| Agent switching | **Swap agent on the same thread** (diverges from swarmcore, which starts a new conversation) | Need `PATCH /threads/{id}` to mutate `agent_id`; next message uses the new agent automatically |
| Layout | **Conversation sidebar** (swarmcore global `/chat` style) | Left 240px thread list + agent picker in the header, chat on the right |
| Live reconnect | **Include it** (full parity) | Backend run-manager that outlives the request + `active-runs` polling + reconnect-on-return |

## 2. Where we are today

- Hierarchy: **Workspace → Thread (bound to one agent, immutable) → Message**.
- Switching is pure navigation. No switcher UI, no "current conversation/agent" state.
  Agent is chosen once in `new-chat-dialog.tsx` at thread creation and can never change.
- Chat transport: frontend `@ag-ui/client` `HttpAgent` keyed by `threadId` (URL param);
  backend `AGUIAdapter.dispatch_request` streams inline — the run lives and dies with the HTTP request.
- Routes: `/workspaces/:id` (thread list) and `/workspaces/:id/threads/:threadId` (chat).

## 3. Target architecture

Lursor **Workspace** maps onto swarmcore **Project**; the swarmcore chat engine
(`use-chat.ts`) + global-chat sidebar layout is what we port.

```
/workspaces/:workspaceId/chat        ← single chat surface (NEW primary route)
┌──────────┬───────────────────────────────────────────┐
│ + New    │  Agent: [picker ▾]   • status   [⋯ menu]   │  header
│ conv 1 ● │──────────────────────────────────────────-│
│ conv 2   │  message list                              │
│ conv 3   │                                            │
│          │──────────────────────────────────────────-│
│          │  composer                                  │
└──────────┴───────────────────────────────────────────┘
   sidebar          ● = active background run (from /active-runs)
```

- Selected conversation = local state, persisted to `localStorage` per workspace
  (swarmcore keeps it out of the URL). Optional `?c=<threadId>` deep-link (nice-to-have).
- Agent picker lists the workspace's agents; changing it `PATCH`es the current thread's `agent_id`.
- A polled `/active-runs` set drives the ● running indicators and the reconnect decision.

### Feasibility confirmed
`pydantic-ai` 2.8.0 (installed) exposes the low-level AG-UI APIs the run-manager needs:
`AGUIAdapter.from_request(...)` → `run_stream(...)` (yields events) → `encode_stream(...)`
(SSE lines) → `streaming_response(...)`. We can tee events (accumulate text for
partial-persist) while encoding them for the wire. No dependency bump required.

---

## 4. Backend changes

### B1 — `PATCH /threads/{id}` (rename + change agent)
- `backend/app/schemas/thread.py`: add `ThreadUpdate { title?: str; agent_id?: str }`.
- `backend/app/api/threads.py`: add `patch_thread` — validate `agent_id` exists if present,
  apply fields, bump `updated_at`, return `ThreadRead`.
- The chat endpoint already resolves the agent from `thread.agent_id` per run, so a swapped
  agent takes effect on the very next message with no other change.

### B2 — `chat_run_manager.py` (NEW) — decouple run from request
`backend/app/agents/chat_run_manager.py`, a module-level singleton mirroring swarmcore:
- State: `_tasks: dict[str, asyncio.Task]`, `_queues: dict[str, set[Queue]]`,
  `_buffers: dict[str, list[str]]` (encoded SSE lines), `_status: dict[str, str]`,
  `_finished_order: deque`.
- Bounds: `MAX_BUFFER_EVENTS=5000` (trim oldest 1000), `MAX_FINISHED_RETAINED=200`.
- `start_run(thread_id, driver) -> bool`: 409-guard if already active; reset buffer/status;
  spawn manager-owned `asyncio.create_task(_wrapped())` (task NOT owned by the request).
- `publish(thread_id, encoded)`: append to buffer (+trim) and `put_nowait` to each queue.
- `finish(thread_id, status)`: first-wins terminal status + send `None` sentinel to all queues + evict.
- `subscribe(thread_id) -> (queue, replay_snapshot)`: **snapshot buffer then register with NO
  `await` in between** (the critical no-lost-events invariant).
- `unsubscribe`, `is_running`, `active_threads`, `stop`.

### B3 — Refactor `backend/app/api/chat.py` to run through the manager
`POST /threads/{thread_id}/chat` becomes:
1. Load thread/agent/workspace (as today); persist inbound user turn up-front (as today).
2. Build `adapter = AGUIAdapter.from_request(request, agent=agent)` synchronously (captures messages/state).
3. Define `driver()`: iterate `adapter.encode_stream(_tee(adapter.run_stream(deps=deps, on_complete=...)))`,
   `publish`-ing each encoded line; `_tee` accumulates assistant text for partial-persist.
   On success `on_complete` persists the assistant turn (existing logic); on `CancelledError`
   persist partial + `finish(..., "stopped")`; on error `finish(..., "error")`.
4. `if not chat_run_manager.start_run(thread_id, driver): raise HTTPException(409)`.
5. `return subscribe_chat_sse(thread_id)` — a `StreamingResponse` that only subscribes
   (replay buffer → live queue with 25s keepalive → `None` sentinel closes).

`subscribe_chat_sse(thread_id)` is a shared helper used by both the POST and the reconnect GET.

### B4 — New conversation-run routes
Add to `threads.py` (or a small `runs.py`) — **declare `/active-runs` before `/{thread_id}`**:
- `GET /threads/active-runs -> list[str]` → `chat_run_manager.active_threads()`.
- `GET /threads/{thread_id}/stream` → `subscribe_chat_sse(thread_id)` (reconnect; replays buffer).
- `POST /threads/{thread_id}/stop` → `chat_run_manager.stop(thread_id)` (404 if none active).

No DB migration needed (no new columns; `Thread`/`Message` unchanged).

---

## 5. Frontend changes

### F1 — API layer
- `api/threads.ts`: add `update(id, {title?, agent_id?})` + `useUpdateThread` (invalidate list & detail);
  `activeRuns()` → `GET /threads/active-runs`; `stop(id)` → `POST /threads/{id}/stop`.
- `api/types.ts`: add `ThreadUpdate`.
- `useActiveRuns()` hook: React Query, `refetchInterval: 3000`, `placeholderData: keepPreviousData`,
  returns `Set<string>`.

### F2 — Chat engine refactor (`agui/useChat.ts`, replaces `useAgentChat`)
Signature: `useChat({ workspaceId, agentId, activeRuns, reconnect })`. Owns:
- `selectedThreadId` state, `messages`, `isStreaming`, `error`, an `AbortController` ref.
- `loadConversation(id)`: abort current stream (run keeps running server-side), clear UI,
  fetch persisted messages, and if `reconnect && activeRuns.has(id)` → `reconnectToRun(id)`.
- `startNewConversation()`: abort + reset to blank, `selectedThreadId = null`.
- `send(text)`: if no `selectedThreadId`, **lazily create the thread** (`POST /threads` with
  the selected agent) then stream. Keeps the existing `HttpAgent` POST transport.
- `reconnectToRun(id)`: GET-subscribe to `/threads/{id}/stream` via a small custom SSE reader,
  feeding the **same reducer** as the send path.
- Factor the AG-UI event→reducer mapping into one `applyAguiEvent(...)` used by both the
  `HttpAgent` callbacks and the reconnect reader (avoids divergence).

> Reconnect needs a GET SSE reader because `HttpAgent.runAgent` always POSTs (a POST would
> start a second run → 409). Small `consumeThreadStream(id, handlers, signal)` fetch helper.

### F3 — New page `pages/chat/workspace-chat-page.tsx`
- Left 240px sidebar: `+ New` + thread list (`useThreads(workspaceId)`), each row shows title,
  a ● when in `activeRuns`, and a `⋯` menu (rename via `useUpdateThread`, delete via `useDeleteThread`).
  Selecting a row → `chat.loadConversation(id)` + persist to localStorage.
- Header: agent `<Select>` over the workspace's agents (`useWorkspace` → `useAgents`); on change
  → `useUpdateThread({agent_id})` (or, if new/unsaved, set the agent for lazy creation). Status dot.
- Body/composer: reuse existing `ChatMessageList` / `ChatComposer`.
- Restores last agent+conversation from localStorage on mount.

### F4 — Routing, persistence, cleanup
- `App.tsx`: add `/workspaces/:workspaceId/chat` → `WorkspaceChatPage`. Redirect the old
  `/workspaces/:workspaceId/threads/:threadId` → the new page (select that thread). Point
  `workspace-detail-page` "open" and `new-chat-dialog` at the new surface (dialog can stay for
  "new chat with agent X", or be replaced by the in-page `+ New` + agent picker).
- `lib/page-session.ts` (NEW): typed localStorage — `workspace-chat: { [workspaceId]: { agentId, threadId } }`.
- Retire `useAgentChat` / `chat-page.tsx` once the new page is in.

---

## 6. Risks & notes
- **`from_request` timing**: must fully parse the request body before the handler returns
  (the driver runs in the background). Confirm it's awaited/synchronous at build time.
- **Double body read**: we read `request.json()` for user-turn persistence and `from_request`
  reads it again — Starlette caches the body (today's code already double-reads), so OK.
- **Event attribute for text accumulation**: identify the pydantic-ai UI event type/attr for
  `TEXT_MESSAGE_CONTENT` deltas in `_tee` (verify against 2.8.0 at impl time).
- **One run per conversation**: concurrent send while a run is active → 409 (matches swarmcore).
- **Empty threads**: lazy creation avoids orphan threads from "New" that never send.

## 7. Out of scope (this pass)
Auth, Docker sandboxing, subagent/todo/file-change side panels, `@`-mentions, auto-title via
side-channel event (we keep the existing first-message title), agent-per-message.

## 8. Suggested build order (each a checkpoint)
1. B1 (PATCH thread) + F1 (api) — smallest vertical slice, unblocks agent switching.
2. F2 + F3 + F4 **without reconnect** (`reconnect: false`) — full switch-any-time UX, stream aborts on switch.
3. B2 + B3 + B4 — run-manager, decoupled runs, reconnect endpoints.
4. Turn on `reconnect: true` + `useActiveRuns` — live reconnect + running indicators.
5. Verify end-to-end; retire old chat page.

## 9. Verification (2026-07-10)

**Backend** — `ruff` clean; `pytest` 7/7 pass (added `test_thread_update_and_run_endpoints`
covering agent swap, unknown-agent 400, `active-runs` route ordering, idle-stop 404).

Live server (real OpenRouter key), exercised over HTTP:
- **Decoupled chat**: `POST /threads/{id}/chat` streams `RUN_STARTED → TEXT_MESSAGE_START →
  CONTENT → END → RUN_FINISHED`; user + assistant turns persisted; title auto-set.
- **active-runs**: lists the thread mid-flight, empty after finish.
- **Reconnect**: `GET /threads/{id}/stream` replays the buffer and follows the live stream
  mid-run; after finish it replays the retained buffer and closes cleanly.
- **Stop**: `POST /threads/{id}/stop` cancels a live run (→ `{stopped:true}`), clears
  active-runs, 404s on repeat, and persists the partial assistant answer (verified 58
  streamed deltas → 319-char partial saved).
- **Agent swap**: `PATCH /threads/{id}` swaps `agent_id` in place; next run uses it.

**Frontend** — `tsc --noEmit` clean; `oxlint` clean (only pre-existing fast-refresh
warnings); `vite build` succeeds. Old `chat-page.tsx`, `useAgentChat.ts`, and
`new-chat-dialog.tsx` retired; old `/threads/:threadId` URL redirects into the new surface.

### Files
Backend: `app/agents/chat_run_manager.py` (new), `app/api/chat.py`, `app/api/threads.py`,
`app/schemas/thread.py`, `tests/test_api.py`.
Frontend: `src/agui/useChat.ts` (new), `src/agui/stream-reader.ts` (new),
`src/lib/page-session.ts` (new), `src/pages/chat/workspace-chat-page.tsx` (new),
`src/agui/agent.ts`, `src/api/threads.ts`, `src/api/types.ts`, `src/App.tsx`,
`src/components/layout/app-shell.tsx`, `src/pages/workspaces/workspace-detail-page.tsx`.
Removed: `src/pages/chat/chat-page.tsx`, `src/agui/useAgentChat.ts`,
`src/pages/workspaces/new-chat-dialog.tsx`.
