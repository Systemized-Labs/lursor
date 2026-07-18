# PLAN: Chat v2 — clean, state-of-the-art chat surface

Status: **implemented**
Owner: chat surface
Related: [PLAN-chat-modes.md](./PLAN-chat-modes.md), [PLAN-goal-mode.md](./PLAN-goal-mode.md)

Implementation notes:
- Shipped as new files under `src/agui/v2/` and `src/components/chat/v2/`; the
  route `workspaces/:workspaceId/chat` now renders `WorkspaceChatPageV2`. v1 files
  remain on disk, unreferenced (delete in a later pass).
- **Open question #1 (per-char reveal):** removed. Smoothness comes from
  use-stick-to-bottom's scroll easing + bounded markdown re-parse.
- **Open question #2 (store lifetime):** single store instance per surface mount
  (`createChatStore()` in a ref), cleared atomically on open/new via `resetMessages`
  — the `loadSeq` guard already prevents stale-load clobber, so per-conversation
  stores weren't needed.
- **Open question #3 (toggle):** none — replaced inline.
- `StreamingText` uses a stable-prefix + growing-tail split (not per-block wrappers)
  so at most two markdown renders exist mid-stream; settled turns render as one
  document for exact final layout.
- Leaf rows (`MessageRow`, `AssistantGroup`, `AssistantSegment`) are `memo`'d so
  page re-renders (composer keystrokes, todo updates) don't cascade into the
  timeline — only the store-subscribed streaming segment re-renders per token.
- Transport (`agent.ts` + `stream-reader.ts`) reused verbatim; both live-send and
  reconnect feed the same handlers → store actions (dual-transport invariant kept).
- Verified: `tsc -b`, `oxlint`, and `vite build` all clean.

## Goal

Rebuild the chat surface as **v2**: same features, clean code, and — critically —
fix the four chronic defects:

1. **Re-render flashes** — every streamed token re-renders the whole timeline.
2. **Doesn't stick to the bottom** — hand-rolled scroll plumbing detaches wrongly.
3. **Streaming isn't smooth** — full markdown re-parse every animation frame.
4. **Older messages flash in too soon** — client windowing has no stable anchor.

v1 stays on disk, unreferenced. v2 is built in new files and **wired in at the
same route** (`workspaces/:workspaceId/chat`). No dev toggle, no separate route.

### Decisions (confirmed with user)

- **State model:** external store with per-message subscriptions (Zustand). A
  streamed token updates one message's slice; only that bubble re-renders.
- **New deps:** allowed — `zustand`, `use-stick-to-bottom`.
- **Rollout:** replace inline. Build v2 in new files, point the route at it, leave
  v1 files unreferenced (delete in a later pass once v2 is proven).
- **Parity:** full — every feature listed in "Feature parity checklist" ships.

## Root-cause diagnosis (why v1 misbehaves)

All four defects trace to **one array of messages in one hook**:

- `useChat` holds `useState<ChatMessage[]>` (`useChat.ts:206`). Every AG-UI event
  does `setMessages(prev => reducer(prev, …))` (`useChat.ts:311-345`). Even with
  identity-preserving reducers (`reducer.ts`) and `memo` on the group
  (`ChatMessageBubble.tsx:243`), the **list component itself** re-renders on every
  token because its `messages` prop changes identity. That churn is the flash.
- Scroll is hand-rolled in the page: a `scroll` listener + `ResizeObserver` +
  `stickToBottodRef` + `BOTTOM_THRESHOLD` (`workspace-chat-page.tsx:334-417`). It
  works most of the time but fights the render churn and the RAF reveal for
  control of `scrollTop`, which is where the "won't stick" and jump behavior come
  from.
- `StreamingMarkdown` re-parses the **entire** message markdown every RAF frame
  (`ChatMessageBubble.tsx:78-101`) — O(message length) per frame, so long turns
  get janky exactly when smoothness matters most.
- Windowing (`ChatMessageList.tsx`, `visibleCount`/`resetKey`) mounts the trailing
  N messages, then a `useLayoutEffect` tries to fix scroll after paint — so older
  turns are briefly visible before the pin. That's the "appears too soon" flash.

**What is NOT broken and will be reused verbatim:** the transport + event sink.
`agent.ts` (dual URLs, `HttpAgent`) and `stream-reader.ts` (the `ChatEventHandlers`
sink + reconnect SSE parser) are solid, and the sink's single-shape-for-both-
transports design is exactly what we want to keep (new stream events must stay
wired into both live-send and reconnect — see memory `agui-event-dual-transport`).

## Architecture

### Layered, with a clear seam between transport, state, and view

```
transport (reuse)      agent.ts · stream-reader.ts  → ChatEventHandlers sink
        │
state (new)            chatStore (Zustand)          ← engine writes here
        │                order:string[] · byId:Record<id,ChatMessage>
        │                todos · goalStatus · isStreaming · error
        │
controller (new)       useChatEngine()              send/stop/load/queue/reconnect
        │                                            wires handlers → store actions
        │
view (new + reuse)     ChatTimeline → MessageRow(id) → UserBubble | AssistantGroup
                       wrapped in <StickToBottom>    (per-message subscribe)
```

### 1. The store — the core fix (`agui/v2/chatStore.ts`)

Normalized, id-keyed, so a token touches one slice:

```ts
interface ChatStoreState {
  order: string[]                       // message ids, render order
  byId: Record<string, ChatMessage>     // the messages
  todos: AgentTodo[]
  goalStatus: AgentGoalStatus | null
  isStreaming: boolean
  error: string | null
  // actions (the reducer.ts logic moves here, mutating one entry):
  reset(messages: ChatMessage[]): void
  appendUser(msg: ChatMessage): void
  upsertAssistant(id: string): void
  setContent(id: string, content: string): void
  setReasoning(id: string, content: string): void
  finishReasoning(id: string): void
  addToolCall(id: string, tc: ChatToolCall): void
  setToolArgs(tcId: string, args: string): void
  setToolResult(tcId: string, result: string): void
  finishStreaming(): void
}
```

Selectors give per-row isolation:

```ts
useMessageOrder()        // subscribes to `order` (changes only when a turn is added)
useMessage(id)           // subscribes to byId[id] (re-renders only that row)
```

**Why this fixes flashes:** `ChatTimeline` subscribes to `order` only, so a
streamed token — which mutates `byId[assistantId]` — notifies **only** that one
`MessageRow`. The list and every other row are untouched. No whole-timeline churn.

One store instance is created **per open conversation** (keyed by threadId) so
opening a thread is a fresh store, not a `reset` race. The engine owns the active
store; the page reads it via context.

### 2. The controller (`agui/v2/useChatEngine.ts`)

A thinner replacement for `useChat`. Keeps everything that was genuinely load-
bearing in v1 (the parts that were about correctness, not rendering):

- `ChatEventHandlers` implementation that calls **store actions** instead of
  `setMessages` (drop-in mapping from `useChat.ts:311-345`).
- send / stop / queue (FIFO, pause-on-stop, edit/remove) — port from `useChat.ts`.
- `loadConversation` with the `loadSeq` monotonic guard and the
  `sendingThreadRef`/`loadedThreadRef` dedupe guards (`useChat.ts:384-417`) — these
  fix real duplicate-bubble/clobber races and must survive.
- `reconnectToRun` via `consumeThreadStream` gated on `useActiveRuns`
  (`useChat.ts:358-382`) — unchanged behavior.
- `resolveAssistantId` fallback for models that omit message ids
  (`useChat.ts:301-308`).

### 3. Scroll — `use-stick-to-bottom` (`ChatTimeline.tsx`)

Delete the entire hand-rolled block (`workspace-chat-page.tsx:334-417`). Wrap the
timeline in `<StickToBottom>`; use `<StickToBottom.Content>` for the growing list
and `useStickToBottomContext()` for the "Jump to latest / New messages" button.

The library is purpose-built for streaming AI chat: it pins with a resize-aware
animation, distinguishes user-scroll from content-growth (our `movedUp` heuristic,
but correct and maintained), and pins **before paint** so freshly-loaded history
never flashes scrolled-up. This directly fixes defects 2 and 4.

### 4. Streaming — block-memoized markdown (`StreamingText.tsx`)

Stop re-parsing the whole message each frame. Split the streamed content into
markdown blocks (on blank lines, respecting open code fences) and render each
block as its **own memoized `MarkdownRenderer`**. Completed blocks keep identity
and never re-parse; only the final, still-growing block re-renders. Parsing cost
becomes O(last block), not O(message).

With smooth autoscroll from `use-stick-to-bottom` doing the visual easing, the
per-character RAF reveal (`REVEAL_DIVISOR`) is **removed** — it was the jank
source and is redundant once scrolling is smooth. `StreamingText` subscribes to
`byId[id].content` and renders live.

### 5. Timeline & windowing (`ChatTimeline.tsx`)

- Grouping (user turn + assistant group) is derived from a **lightweight
  projection** of `order` (id + role only), memoized, so grouping recomputes only
  when a turn is added — not on tokens. Port `groupMessages`/`groupTurns` logic
  from `ChatMessageList.tsx:30-73`.
- Windowing: mount the trailing N turns from first paint (inside `<StickToBottom>`,
  so the pin is correct before paint — no "too soon" flash). "Show older" expands
  the window; the library preserves scroll offset on prepend. No virtualization
  (streaming + variable-height markdown + autoscroll make it a net loss; revisit
  only if perf demands it — noted in Out of scope).

## Reuse vs rebuild

**Rebuild** (the bug sources):

| v1 | v2 |
|----|----|
| `agui/useChat.ts` (state + control) | `agui/v2/chatStore.ts` + `agui/v2/useChatEngine.ts` |
| `agui/reducer.ts` | folded into store actions |
| `ChatMessageList.tsx` (list + windowing + scroll fixups) | `components/chat/v2/ChatTimeline.tsx` |
| `ChatMessageBubble.tsx` (bubble + RAF reveal) | `components/chat/v2/MessageRow.tsx`, `UserBubble.tsx`, `AssistantGroup.tsx`, `StreamingText.tsx` |
| scroll plumbing in `workspace-chat-page.tsx` | `<StickToBottom>` in `ChatTimeline` |

**Reuse as-is** (not implicated in the defects — keep, don't touch):

- Transport: `agui/agent.ts`, `agui/stream-reader.ts`, `agui/file-changes.ts`,
  `agui/types.ts`.
- Composer + its subsystems: `ChatComposer.tsx`, `commands/*`, `mentions/*`
  (slash, @-mentions, queue UI, mode pill, attachments).
- Feature blocks: `ChatReasoning.tsx`, `ChatToolCalls.tsx`,
  `ChatSubagentCalls.tsx`, `ChatFilesChanged.tsx`, `ChatTodoList.tsx`,
  `GoalPanel.tsx` + `minigames/DinoRunner.tsx`.
- Rendering: `ui/markdown-renderer.tsx` (wrapped by `StreamingText` for block
  memoization; `CodeBlock`/`MarkdownLink`/emoji-icons unchanged).

These blocks already take a `ChatMessage`/`toolCalls`/`todos` shape, so they slot
under `AssistantGroup` unchanged. Because each is rendered inside a per-message-
subscribed `MessageRow`, they get the isolation win for free.

## Changes by file

### New deps
- `zustand` (~1kb store, per-slice subscriptions).
- `use-stick-to-bottom` (streaming-aware autoscroll).
- Install with **bun** (memory `pnpm-deadlocks-use-bun`): `bun add zustand use-stick-to-bottom`.

### New files
1. `frontend/src/agui/v2/chatStore.ts` — the store + selectors (§1).
2. `frontend/src/agui/v2/useChatEngine.ts` — controller (§2), reusing
   `agent.ts` + `stream-reader.ts`.
3. `frontend/src/components/chat/v2/ChatTimeline.tsx` — `<StickToBottom>`, grouping,
   windowing, jump button (§3, §5).
4. `frontend/src/components/chat/v2/MessageRow.tsx` — `useMessage(id)` subscriber,
   routes to user vs assistant.
5. `frontend/src/components/chat/v2/UserBubble.tsx` — user turn (badge, attachments,
   `renderWithIcons`).
6. `frontend/src/components/chat/v2/AssistantGroup.tsx` — assistant segments
   (reasoning · text · subagents · tools · files-changed · copy).
7. `frontend/src/components/chat/v2/StreamingText.tsx` — block-memoized markdown (§4).
8. `frontend/src/pages/chat/workspace-chat-page-v2.tsx` — the v2 surface: header,
   `ChatTimeline`, `ChatTodoList`, error line, `GoalRunPanel`/`ChatComposer`.

### Edited files
9. `frontend/src/App.tsx` — point `workspaces/:workspaceId/chat` (currently
   `App.tsx:80-82`) at `workspace-chat-page-v2`. v1 page left on disk, unimported.

### Untouched
Backend, all reused components/subsystems above.

## Feature parity checklist

- [ ] Streaming assistant text (smooth, block-memoized)
- [ ] Reasoning/thinking collapsible (`ChatReasoning`)
- [ ] Tool ticker + expandable rows (`ChatToolCalls`)
- [ ] Subagent/`task` delegation cards (`ChatSubagentCalls`)
- [ ] Files-changed summary (`ChatFilesChanged` + `file-changes.ts`)
- [ ] Live todo list (`ChatTodoList`, CUSTOM `todos` event)
- [ ] Goal lifecycle + `GoalRunPanel` + Dino minigame + interject/steer
- [ ] Markdown: GFM, code blocks w/ copy, link context menu, emoji→icons
- [ ] Image attachments (paste/drag/button → multimodal parts, thumbnails, `/media/`)
- [ ] Slash commands (`/ask` `/plan` `/goal` `/clear`) + menu
- [ ] @-mentions (`@files` lazy, `@skill` preloaded) + forced skill load
- [ ] Message queue (FIFO, edit/remove, pause-on-stop, resume)
- [ ] Modes: chat / ask / plan / goal + per-turn kind badges
- [ ] Copy per turn and per code block
- [ ] Reconnect to in-flight run on open (dual transport)
- [ ] Stick-to-bottom + jump/"new messages" button
- [ ] "Show older messages" windowing (no early flash)
- [ ] Title edit, agent select, new-conversation, unread indicator, active-run dots

## Testing / verification

Manual (no test harness for the chat UI today; verify by hand + `bun run dev`):

- **No flash:** stream a long turn; confirm only the streaming bubble repaints
  (React DevTools "highlight updates" — list and prior turns stay dark).
- **Sticks:** stream while at bottom → stays pinned; scroll up mid-stream →
  detaches + "New messages" button; click → re-pins.
- **Smooth:** long turn streams without jank; code fences don't re-highlight
  earlier blocks.
- **Older:** open a long thread → opens pinned to the latest with no older-turn
  flash; "Show older" preserves scroll position.
- **Reconnect:** start a run, navigate away and back → rejoins the live stream
  (both transports), no duplicate bubble.
- **Parity sweep:** walk the checklist above in dark + light mode; verify every
  text element uses `text-foreground`/`text-muted-foreground` (global UI rules).
- `bun run lint` clean.

## Out of scope

- Backend changes / real pagination (windowing stays client-side).
- Virtualized timeline (revisit only if profiling shows a need).
- Deleting v1 files (a follow-up once v2 is proven in daily use).
- Composer/commands/mentions internals (reused unchanged).

## Open questions

1. Keep the smooth per-character reveal at all, or fully rely on
   `use-stick-to-bottom`'s scroll easing (proposed: remove the RAF reveal)?
2. One store per conversation (proposed) vs a single store `reset` on open — any
   preference given the reconnect/queue edge cases?
3. Confirm no v1/v2 toggle is wanted (proposed: none — replace inline).
