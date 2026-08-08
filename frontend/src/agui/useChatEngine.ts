import { useCallback, useEffect, useRef } from "react"
import { HttpAgent, type Message, randomUUID } from "@ag-ui/client"

import type {
  MessageKind,
  Thread,
  ThreadMessage,
  TurnIntent,
} from "@/api/types"
import { threadsApi } from "@/api/threads"
import { markRunSettled, markRunStarted } from "@/hooks/use-optimistic-runs"
import { expandMentionTokens, mentionSlugs } from "@/components/chat/mentions/types"

import { createThreadAgent, mediaUrl } from "@/agui/agent"
import {
  consumeThreadStream,
  GOAL_STATUS_EVENT_NAME,
  parseGoalStatus,
  parseTodos,
  TODOS_EVENT_NAME,
  type ChatEventHandlers,
} from "@/agui/stream-reader"
import type { ChatMessage, PendingAttachment } from "@/agui/types"

import {
  createChatStore,
  selectMessages,
  type ChatStore,
  type QueuedMessage,
} from "./chatStore"

// --- pure mapping helpers ---------------------------------------------------

/** Maps persisted thread messages into the UI message shape. Attachments are
 *  resolved to server media URLs scoped to the thread they belong to. */
function toChatMessages(messages: ThreadMessage[], threadId: string): ChatMessage[] {
  return messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    kind: m.kind,
    agentId: m.agent_id ?? undefined,
    agentName: m.agent_name || undefined,
    toolCalls: Array.isArray(m.tool_calls)
      ? m.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          args: tc.arguments,
          result: tc.result ?? undefined,
        }))
      : [],
    attachments: m.attachments?.map((a) => ({
      url: mediaUrl(threadId, a.media_id),
      mimeType: a.mime_type,
      name: a.filename ?? undefined,
    })),
  }))
}

/** AG-UI multimodal content part shapes (subset we emit). */
type AgUiContentPart =
  | { type: "text"; text: string }
  | {
      type: "image"
      source: { type: "data"; value: string; mimeType: string }
      metadata?: { filename?: string }
    }

/** Builds the AG-UI user-message content: a plain string when there are no
 *  attachments, otherwise a parts array carrying the inline images. */
function buildUserContent(
  text: string,
  attachments: PendingAttachment[]
): string | AgUiContentPart[] {
  if (attachments.length === 0) return text
  const parts: AgUiContentPart[] = []
  if (text) parts.push({ type: "text", text })
  for (const a of attachments) {
    parts.push({
      type: "image",
      source: { type: "data", value: a.base64, mimeType: a.mimeType },
      metadata: { filename: a.name },
    })
  }
  return parts
}

/** True for the error raised when a fetch/stream is aborted (switch/stop). It's
 *  expected, not a failure, so callers skip it instead of painting a chat error. */
function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true
  if (err instanceof Error) {
    if (err.name === "AbortError") return true
    return /\baborted\b/i.test(err.message)
  }
  return false
}

/** The message to paint for a failed request, unwrapping FastAPI's error body.
 *
 *  The AG-UI client rejects with `HTTP 409: {"detail":"…"}` — the raw response body
 *  spliced into the message — so a backend refusal reached the transcript as JSON
 *  the user had to read past. The `detail` is already a written-for-humans
 *  sentence, so surface just that; anything unexpected falls through unchanged. */
function chatErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback
  const body = err.message.match(/^HTTP \d{3}: (\{.*\})$/s)?.[1]
  if (!body) return err.message
  try {
    const detail = (JSON.parse(body) as { detail?: unknown }).detail
    return typeof detail === "string" && detail.trim() ? detail : err.message
  } catch {
    return err.message
  }
}

/** Maps UI messages to AG-UI history (tool-role turns are UI-only). */
function toAgentMessages(messages: ChatMessage[]): Message[] {
  const result: Message[] = []
  for (const m of messages) {
    if (m.role === "user" || m.role === "assistant" || m.role === "system") {
      result.push({ id: m.id, role: m.role, content: m.content })
    }
  }
  return result
}

// --- engine ----------------------------------------------------------------

export interface UseChatEngineOptions {
  workspaceId: string | undefined
  /** Agent the next message (and any lazily-created thread) will use. */
  agentId: string | undefined
  /** Display name of {@link agentId}, stamped on the optimistic user bubble so
   *  the agent chip shows instantly (reload replaces it with the persisted snapshot). */
  agentName?: string
  /** Thread ids with a live run; gates reconnect-on-open. */
  activeRuns?: Set<string>
  /** Reconnect to a still-running run when opening a conversation. */
  reconnect?: boolean
  /** Called when a message lazily creates a new thread. */
  onThreadCreated?: (thread: Thread) => void
}

export interface ChatEngine {
  /** The store the surface subscribes to for messages/todos/status/queue. */
  store: ChatStore
  send: (
    text: string,
    attachments?: PendingAttachment[],
    turnIntent?: TurnIntent,
    kind?: MessageKind,
    /** Per-turn agent override. When a slash command switches the agent, the
     *  reassign PATCH lands async, so pass the resolved target here so this turn's
     *  optimistic bubble (and any lazily-created thread) uses it, not stale state. */
    agent?: { id: string; name?: string }
  ) => Promise<void>
  interject: (text: string) => Promise<void>
  stop: () => void
  removeQueued: (id: string) => void
  editQueued: (id: string, text: string) => void
  resumeQueue: () => void
  clearQueue: () => void
  loadConversation: (threadId: string) => Promise<void>
  /** Re-fetch the open thread's persisted messages and reset the store to them.
   *  Unlike {@link loadConversation} it doesn't bail on the already-open thread,
   *  so it's the way to reflect a server-side history change (e.g. /compact). */
  reloadMessages: () => Promise<void>
  startNewConversation: () => void
}

/**
 * The chat engine. Owns the selected conversation, its message stream, and the
 * two transports (an `HttpAgent` POST for sending, a GET SSE reader for
 * reconnecting to an in-flight run). Writes into a normalized {@link ChatStore}
 * (id-keyed messages) rather than a single array, so a streamed token re-renders
 * only the one subscribed message row.
 */
export function useChatEngine(options: UseChatEngineOptions): ChatEngine {
  // One store per surface mount; stable for the engine's lifetime.
  const storeRef = useRef<ChatStore | undefined>(undefined)
  if (!storeRef.current) storeRef.current = createChatStore()
  const store = storeRef.current

  const agentRef = useRef<HttpAgent | null>(null)
  const agentThreadRef = useRef<string | null>(null)
  const reconnectAbortRef = useRef<AbortController | null>(null)
  const currentAssistantId = useRef<string | null>(null)
  // Thread `send` is actively driving via the live POST stream. Set synchronously
  // so `loadConversation` bails before opening a second consumer of the same run.
  const sendingThreadRef = useRef<string | null>(null)
  // Thread currently being (or already) opened by `loadConversation`; a duplicate
  // open of the same thread bails instead of wiping the loaded messages.
  const loadedThreadRef = useRef<string | null>(null)
  // Monotonic token so a slow history load can't clobber a newer conversation.
  const loadSeq = useRef(0)
  // The agent the turn now streaming is running under. Usually the thread's own,
  // but a one-off command ("Execute plan", `/goal`, `/ask`) runs under a per-turn
  // override the thread never learns about — so anything that joins a run already
  // in flight (`interject`) must read the run's agent from here rather than off the
  // selection, or it labels the steer with an agent taking no part in the run.
  const runAgentRef = useRef<{ id: string; name?: string } | null>(null)

  const optionsRef = useRef(options)
  optionsRef.current = options

  const performSendRef = useRef<((msg: QueuedMessage) => Promise<void>) | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => void (mountedRef.current = false)
  }, [])

  const removeQueued = useCallback(
    (id: string) => {
      const s = store.getState()
      s.setQueue(s.queue.filter((m) => m.id !== id))
    },
    [store]
  )

  const editQueued = useCallback(
    (id: string, text: string) => {
      const s = store.getState()
      s.setQueue(s.queue.map((m) => (m.id === id ? { ...m, text } : m)))
    },
    [store]
  )

  const clearQueue = useCallback(() => store.getState().setQueue([]), [store])

  // Send the next queued message (FIFO), re-entering the send path via the ref.
  // Reads paused/queue off the store synchronously so a run's settle handler sees
  // a pause set mid-stream by stop().
  const drainQueue = useCallback(() => {
    const s = store.getState()
    if (!mountedRef.current || s.queuePaused) return
    const [next, ...rest] = s.queue
    if (!next) return
    s.setQueue(rest)
    void performSendRef.current?.(next)
  }, [store])

  const resolveAssistantId = useCallback((messageId?: string) => {
    if (messageId) {
      currentAssistantId.current = messageId
      return messageId
    }
    if (!currentAssistantId.current) currentAssistantId.current = randomUUID()
    return currentAssistantId.current
  }, [])

  /**
   * Single place the AG-UI events touch the store; both transports use it.
   *
   * Scoped to the thread the stream belongs to, and every write goes through `s()`,
   * which returns the store only while that thread is still the open one. A run does
   * not stop the instant the surface leaves it — `abortRun`/`abort` take effect
   * asynchronously and the reader may already hold decoded events — so an unscoped
   * handler kept writing the old run's events into whatever conversation was open
   * next. Starting a new chat mid-run was where it showed: the fresh, cleared
   * conversation inherited the previous run's todo deck (and its assistant text) a
   * beat after `startNewConversation` wiped it.
   *
   * Optional chaining does the guarding: `s()?.setX(resolveAssistantId(id))`
   * short-circuits the whole call, arguments included, so a stale event can't even
   * claim an assistant id.
   */
  const makeHandlers = useCallback(
    (threadId: string | null): ChatEventHandlers => {
      const s = () => {
        const state = store.getState()
        return state.selectedThreadId === threadId ? state : null
      }
      return {
        onTextStart: (messageId) => s()?.upsertAssistant(resolveAssistantId(messageId)),
        onTextContent: (messageId, content) =>
          s()?.setContent(resolveAssistantId(messageId), content),
        onReasoning: (messageId, content) =>
          s()?.setReasoning(resolveAssistantId(messageId), content),
        onReasoningEnd: (messageId) => s()?.finishReasoning(messageId),
        onToolStart: (parentMessageId, toolCallId, toolName) =>
          s()?.addToolCall(resolveAssistantId(parentMessageId), {
            id: toolCallId,
            name: toolName,
            args: "",
          }),
        onToolArgs: (toolCallId, args) => s()?.setToolArgs(toolCallId, args),
        onToolResult: (toolCallId, result) => s()?.setToolResult(toolCallId, result),
        onTodos: (next) => s()?.setTodos(next),
        onGoalStatus: (next) => s()?.setGoalStatus(next),
        onAssistantConfirm: (next) => s()?.setConfirm(next),
        onError: (message) => s()?.setError(message),
      }
    },
    [store, resolveAssistantId]
  )

  const abortLocalStreams = useCallback(() => {
    agentRef.current?.abortRun()
    reconnectAbortRef.current?.abort()
    reconnectAbortRef.current = null
  }, [])

  // On unmount, tear down the local stream consumers so they stop writing to the
  // store. The server run is intentionally left alive to rejoin later.
  useEffect(() => abortLocalStreams, [abortLocalStreams])

  const reconnectToRun = useCallback(
    (threadId: string) => {
      reconnectAbortRef.current?.abort()
      const controller = new AbortController()
      reconnectAbortRef.current = controller
      currentAssistantId.current = null
      store.getState().setIsStreaming(true)

      consumeThreadStream(threadId, makeHandlers(threadId), controller.signal)
        .catch((err: unknown) => {
          if (isAbortError(err)) return
          // Same ownership rule as the events: a reconnect that fails after the
          // surface moved on has no conversation left to report it to.
          if (store.getState().selectedThreadId !== threadId) return
          store.getState().setError(err instanceof Error ? err.message : "Reconnect failed")
        })
        .finally(() => {
          if (reconnectAbortRef.current !== controller) return
          reconnectAbortRef.current = null
          currentAssistantId.current = null
          const s = store.getState()
          s.setIsStreaming(false)
          s.finishStreaming()
          drainQueue()
        })
    },
    [store, makeHandlers, drainQueue]
  )

  const loadConversation = useCallback(
    async (threadId: string) => {
      // Already driving this exact thread via `send`? Opening it again would abort
      // the live POST stream and spin up a reconnect GET stream — two consumers of
      // one run, duplicating the assistant bubble when the model emits no ids.
      if (threadId === sendingThreadRef.current) return
      // Already opened (or opening) this exact thread: a duplicate call would wipe
      // the loaded messages and reload, detaching the view mid-stream.
      if (threadId === loadedThreadRef.current) return
      loadedThreadRef.current = threadId
      abortLocalStreams()
      const seq = ++loadSeq.current
      const s = store.getState()
      s.setSelectedThreadId(threadId)
      s.setError(null)
      s.setIsStreaming(false)
      s.resetMessages([])
      // Queued messages belong to the conversation they were typed in.
      s.setQueue([])
      // A reconnect replays this thread's buffered `todos`; clear first so a stale
      // list from the previous thread can't linger.
      s.setTodos([])
      s.setGoalStatus(null)
      currentAssistantId.current = null
      // The remembered run agent belongs to the conversation we're leaving.
      runAgentRef.current = null
      agentRef.current = createThreadAgent(threadId)
      agentThreadRef.current = threadId

      try {
        const persisted = await threadsApi.messages(threadId)
        if (loadSeq.current !== seq) return // superseded by a newer open
        store.getState().resetMessages(toChatMessages(persisted, threadId))
      } catch (err) {
        if (loadSeq.current !== seq) return
        store
          .getState()
          .setError(err instanceof Error ? err.message : "Failed to load conversation")
      }

      const { reconnect, activeRuns } = optionsRef.current
      if (reconnect && activeRuns?.has(threadId)) reconnectToRun(threadId)
    },
    [store, abortLocalStreams, reconnectToRun]
  )

  // Reload the open thread's persisted messages in place. Guards against a
  // concurrent send/load with the monotonic seq (a newer open wins), and bails
  // while a run streams so it can't clobber the live transcript.
  const reloadMessages = useCallback(async () => {
    const threadId = store.getState().selectedThreadId
    if (!threadId || store.getState().isStreaming) return
    const seq = ++loadSeq.current
    try {
      const persisted = await threadsApi.messages(threadId)
      if (loadSeq.current !== seq) return
      store.getState().resetMessages(toChatMessages(persisted, threadId))
    } catch (err) {
      if (loadSeq.current !== seq) return
      store
        .getState()
        .setError(err instanceof Error ? err.message : "Failed to reload conversation")
    }
  }, [store])

  const startNewConversation = useCallback(() => {
    abortLocalStreams()
    loadSeq.current++
    agentRef.current = null
    agentThreadRef.current = null
    currentAssistantId.current = null
    sendingThreadRef.current = null
    loadedThreadRef.current = null
    runAgentRef.current = null
    const s = store.getState()
    s.setSelectedThreadId(null)
    s.resetMessages([])
    s.setTodos([])
    s.setGoalStatus(null)
    s.setError(null)
    s.setIsStreaming(false)
    s.setQueue([])
  }, [store, abortLocalStreams])

  // Streams a single message end to end. Reads no composer state, so it serves
  // both a live submit and a message drained off the queue.
  const performSend = useCallback(
    async ({
      text: trimmed,
      attachments,
      turnIntent,
      kind,
      agentId: turnAgentId,
      agentName: turnAgentName,
    }: QueuedMessage) => {
      const { workspaceId } = optionsRef.current
      // The turn's agent: an explicit per-turn override (a slash switch resolved
      // synchronously by the caller) wins over the engine's current selection.
      const agentId = turnAgentId ?? optionsRef.current.agentId
      const agentName = turnAgentName ?? optionsRef.current.agentName
      if (!workspaceId || !agentId) {
        store.getState().setError("Pick an agent before sending a message.")
        return
      }
      runAgentRef.current = { id: agentId, name: agentName }

      // Lazily create the thread on first send so "New conversation" leaves no
      // orphan threads behind.
      let threadId = store.getState().selectedThreadId
      if (!threadId) {
        try {
          const thread = await threadsApi.create({
            workspace_id: workspaceId,
            agent_id: agentId,
            title: "New conversation",
          })
          threadId = thread.id
          // Claim this thread as ours before the URL update, so the resulting
          // `loadConversation` bails instead of opening a rival stream.
          sendingThreadRef.current = thread.id
          store.getState().setSelectedThreadId(thread.id)
          optionsRef.current.onThreadCreated?.(thread)
        } catch (err) {
          store
            .getState()
            .setError(err instanceof Error ? err.message : "Failed to start conversation")
          return
        }
      }
      sendingThreadRef.current = threadId

      if (!agentRef.current || agentThreadRef.current !== threadId) {
        agentRef.current = createThreadAgent(threadId)
        agentThreadRef.current = threadId
      }
      const agent = agentRef.current
      // Bound to this turn's thread: once the surface leaves it (a new chat, a
      // switch to another conversation), the events this run is still emitting stop
      // reaching the store. See `makeHandlers`.
      const handlers = makeHandlers(threadId)
      // Seed the transport with the current history, then append the new turn.
      agent.setMessages(toAgentMessages(selectMessages(store.getState())))

      // Skills the user @-referenced this turn — read off the raw text before the
      // tokens are collapsed. Force-loaded server-side via forwardedProps.skills.
      const referencedSkills = mentionSlugs(trimmed, "skill")
      // Expand `@/files/…` tokens into plain workspace-relative paths.
      const outgoing = expandMentionTokens(trimmed)
      const userMessage: ChatMessage = {
        id: randomUUID(),
        role: "user",
        content: outgoing,
        toolCalls: [],
        kind,
        agentId,
        agentName,
        attachments: attachments.map((a) => ({
          url: a.dataUrl,
          mimeType: a.mimeType,
          name: a.name,
        })),
      }
      store.getState().appendMessage(userMessage)
      agent.addMessage({
        id: userMessage.id,
        role: "user",
        content: buildUserContent(outgoing, attachments),
      } as Message)

      currentAssistantId.current = null
      const s0 = store.getState()
      s0.setIsStreaming(true)
      s0.setError(null)
      // Show the sidebar "working" dot immediately, without waiting for the poll.
      markRunStarted(threadId)

      try {
        await agent.runAgent(
          {
            forwardedProps: {
              turn: turnIntent,
              // The agent to run this turn under. The backend honors it as a
              // per-turn override when it differs from the thread's own agent
              // (a one-off `/ask` or `/goal`), without persisting it; for a
              // normal turn it equals the thread's agent, so it's a no-op.
              agent_id: agentId,
              ...(referencedSkills.length ? { skills: referencedSkills } : {}),
            },
          },
          {
            onTextMessageStartEvent: ({ event }) =>
              handlers.onTextStart(event.messageId),
            // The `*Buffer` a subscriber receives is the value *before* this
            // event's delta is folded in — the client appends only after the
            // subscriber returns. Add the delta ourselves, or the UI trails the
            // stream by one chunk and never sees the final one at all.
            onTextMessageContentEvent: ({ event, textMessageBuffer }) =>
              handlers.onTextContent(event.messageId, textMessageBuffer + event.delta),
            onReasoningMessageContentEvent: ({ event, reasoningMessageBuffer }) =>
              handlers.onReasoning(event.messageId, reasoningMessageBuffer + event.delta),
            onReasoningMessageEndEvent: ({ event }) =>
              handlers.onReasoningEnd(event.messageId),
            onToolCallStartEvent: ({ event }) =>
              handlers.onToolStart(
                event.parentMessageId,
                event.toolCallId,
                event.toolCallName
              ),
            // Same one-delta lag as the text handlers above. It bites hardest
            // here: a `task` call whose args arrive in a single delta would land
            // as an empty string, so the subagent card never learns which
            // subagent it delegated to and stays stuck on "Delegating…".
            onToolCallArgsEvent: ({ event, toolCallBuffer }) =>
              handlers.onToolArgs(event.toolCallId, toolCallBuffer + event.delta),
            onToolCallResultEvent: ({ event }) =>
              handlers.onToolResult(event.toolCallId, event.content),
            onCustomEvent: ({ event }) => {
              if (event.name === TODOS_EVENT_NAME) {
                const parsed = parseTodos(event.value)
                if (parsed) handlers.onTodos(parsed)
              } else if (event.name === GOAL_STATUS_EVENT_NAME) {
                const goal = parseGoalStatus(event.value)
                if (goal) handlers.onGoalStatus(goal)
              }
            },
            // The AG-UI client turns an aborted fetch into a RUN_ERROR with code
            // "abort" rather than rejecting; drop it — it's expected, not an error.
            onRunErrorEvent: ({ event }) => {
              if (event.code === "abort" || isAbortError(event.rawEvent)) return
              handlers.onError(event.message)
            },
          }
        )
      } catch (err) {
        // An aborted run is expected. Only surface the error on the conversation
        // it belongs to (the selected thread may have switched mid-send).
        if (!isAbortError(err) && store.getState().selectedThreadId === threadId) {
          store.getState().setError(chatErrorMessage(err, "Chat request failed"))
        }
      } finally {
        markRunSettled(threadId)
        if (sendingThreadRef.current === threadId) sendingThreadRef.current = null
        // Only reset shared streaming state if this send still owns the surface.
        if (store.getState().selectedThreadId === threadId) {
          const s = store.getState()
          s.setIsStreaming(false)
          currentAssistantId.current = null
          s.finishStreaming()
        }
        // Chain the next queued message once this run settles.
        drainQueue()
      }
    },
    [store, makeHandlers, drainQueue]
  )
  performSendRef.current = performSend

  const send = useCallback(
    async (
      text: string,
      attachments: PendingAttachment[] = [],
      turnIntent: TurnIntent = "chat",
      // `execute_plan` isn't a persisted message kind (it has no body); it kicks
      // off a goal, so badge any stray message as "goal".
      kind: MessageKind = turnIntent === "execute_plan" ? "goal" : turnIntent,
      agent?: { id: string; name?: string }
    ) => {
      const trimmed = text.trim()
      if (!trimmed && attachments.length === 0) return
      const msg: QueuedMessage = {
        id: randomUUID(),
        text: trimmed,
        attachments,
        turnIntent,
        kind,
        agentId: agent?.id,
        agentName: agent?.name,
      }
      // Append while a run streams, or while a pending queue exists, so new
      // messages join the batch in order rather than jumping ahead.
      const s = store.getState()
      if (s.isStreaming || s.queue.length > 0) {
        s.setQueue([...s.queue, msg])
        return
      }
      await performSend(msg)
    },
    [store, performSend]
  )

  // Steer a running goal without opening a second run: POST to the interject
  // endpoint (the backend buffers it into the next turn) and optimistically show it.
  const interject = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      const threadId = store.getState().selectedThreadId
      if (!threadId) return
      const outgoing = expandMentionTokens(trimmed)
      // The run's agent, not the selection — see `runAgentRef`. Matches what the
      // backend persists for this steer, so the reload reconciles to the same badge.
      const runAgent = runAgentRef.current
      store.getState().appendMessage({
        id: randomUUID(),
        role: "user",
        content: outgoing,
        toolCalls: [],
        kind: "goal",
        agentId: runAgent?.id ?? optionsRef.current.agentId,
        agentName: runAgent?.name ?? optionsRef.current.agentName,
      })
      try {
        await threadsApi.interjectGoal(threadId, outgoing)
      } catch (err) {
        store
          .getState()
          .setError(err instanceof Error ? err.message : "Failed to send message")
      }
    },
    [store]
  )

  const resumeQueue = useCallback(() => {
    store.getState().setQueuePaused(false)
    drainQueue()
  }, [store, drainQueue])

  const stop = useCallback(() => {
    const s = store.getState()
    // Pause (don't drop) queued messages so the settling stream's drain doesn't
    // auto-fire them; the user resumes explicitly.
    if (s.queue.length > 0) s.setQueuePaused(true)
    abortLocalStreams()
    s.setIsStreaming(false)
    s.finishStreaming()
    // Aborting drops us before the server's `stopped` event; optimistically mark a
    // live goal stopped so the Stop button clears. The server confirms via state.
    s.markGoalStopped()
    const threadId = s.selectedThreadId
    if (threadId) threadsApi.stop(threadId).catch(() => {})
  }, [store, abortLocalStreams])

  return {
    store,
    send,
    interject,
    stop,
    removeQueued,
    editQueued,
    resumeQueue,
    clearQueue,
    loadConversation,
    reloadMessages,
    startNewConversation,
  }
}
