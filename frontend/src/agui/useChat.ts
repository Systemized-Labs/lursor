import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { HttpAgent, type Message, randomUUID } from "@ag-ui/client"

import type {
  MessageKind,
  Thread,
  ThreadMessage,
  ThreadMode,
  TurnIntent,
} from "@/api/types"
import { threadsApi } from "@/api/threads"

import { expandMentionTokens } from "@/components/chat/mentions/types"

import { createThreadAgent, mediaUrl } from "./agent"
import {
  addToolCall,
  finishReasoning,
  finishStreaming,
  setAssistantContent,
  setReasoning,
  setToolCallArgs,
  setToolCallResult,
  upsertAssistant,
} from "./reducer"
import {
  consumeThreadStream,
  GOAL_STATUS_EVENT_NAME,
  parseGoalStatus,
  parseTodos,
  TODOS_EVENT_NAME,
  type ChatEventHandlers,
} from "./stream-reader"
import type {
  AgentGoalStatus,
  AgentTodo,
  ChatMessage,
  PendingAttachment,
} from "./types"

/** Maps persisted thread messages into the UI message shape. Attachments are
 *  resolved to server media URLs scoped to the thread they belong to. */
export function toChatMessages(
  messages: ThreadMessage[],
  threadId: string
): ChatMessage[] {
  return messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    kind: m.kind,
    // `tool_calls` is an opaque JSON object by default; narrow before mapping.
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

/** True for the error raised when a fetch/stream is aborted (e.g. the user
 *  switched conversation or hit stop, which aborts the local run). It's expected,
 *  not a failure, so callers skip it instead of painting it as a chat error.
 *
 *  We match the message, not just `name === "AbortError"`: the AG-UI client
 *  already swallows genuine `AbortError`s itself, so anything reaching our catch
 *  is the Chromium body-stream abort, whose DOMException carries the message
 *  "BodyStreamBuffer was aborted" under a name the library's allowlist misses. */
function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true
  if (err instanceof Error) {
    if (err.name === "AbortError") return true
    return /\baborted\b/i.test(err.message)
  }
  return false
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

export interface UseChatOptions {
  workspaceId: string | undefined
  /** Agent the next message (and any lazily-created thread) will use. */
  agentId: string | undefined
  /** Thread ids with a live run; gates reconnect-on-open. */
  activeRuns?: Set<string>
  /** Reconnect to a still-running run when opening a conversation. */
  reconnect?: boolean
  /** Called when a message lazily creates a new thread. */
  onThreadCreated?: (thread: Thread) => void
}

/** A message the user submitted while a run was still streaming. Queued
 *  messages auto-send (FIFO) once the active run settles. */
export interface QueuedMessage {
  id: string
  text: string
  attachments: PendingAttachment[]
  /** Per-turn intent captured when the message was submitted (defaults "chat").
   *  Read at send time so a queued turn keeps the intent it was typed with. */
  turnIntent: TurnIntent
  /** Display kind for the history badge (chat/ask/plan/goal). Distinct from
   *  `turnIntent` because a plan-mode turn rides the wire as "chat". */
  kind: MessageKind
}

/** Plan/goal config applied when a thread is lazily created via `startMode`. */
export interface ThreadModeInit {
  mode: ThreadMode
  goal: string
  successCriteria: string
  maxIterations: number
}

export interface UseChat {
  selectedThreadId: string | null
  messages: ChatMessage[]
  /** The agent's live todo list for the open conversation (empty when none). */
  todos: AgentTodo[]
  /** Live goal state for the open conversation, or null in plain chat. */
  goalStatus: AgentGoalStatus | null
  isStreaming: boolean
  error: string | null
  /** Messages waiting to send after the current run settles (FIFO). */
  queue: QueuedMessage[]
  /** The queue holds messages but won't auto-drain (set when a run is stopped). */
  queuePaused: boolean
  send: (
    text: string,
    attachments?: PendingAttachment[],
    turnIntent?: TurnIntent,
    kind?: MessageKind
  ) => Promise<void>
  /** Enter plan/goal mode on a fresh conversation: lazily creates the thread
   *  (via the same path as `send`, avoiding the load/clobber race) with the mode
   *  config, and sends the first turn. */
  startMode: (text: string, init: ThreadModeInit) => Promise<void>
  /** Steer a running goal: buffer a message for the loop's next turn (does not
   *  start a new run). Optimistically shows the user's message in the thread. */
  interject: (text: string) => Promise<void>
  stop: () => void
  /** Drop a queued message before it sends. */
  removeQueued: (id: string) => void
  /** Replace a queued message's text in place. */
  editQueued: (id: string, text: string) => void
  /** Resume a paused queue, firing it now. */
  resumeQueue: () => void
  /** Drop every queued message. */
  clearQueue: () => void
  loadConversation: (threadId: string) => Promise<void>
  startNewConversation: () => void
}

/**
 * The chat engine. Owns the selected conversation, its message stream, and the
 * transports: an `HttpAgent` POST for sending and a GET SSE reader for
 * reconnecting to a run left in flight. `loadConversation` / `startNewConversation`
 * let the surface switch conversation (and, via `agentId`, agent) at any time —
 * switching aborts the local stream but leaves the server run alive to rejoin.
 */
export function useChat(options: UseChatOptions): UseChat {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [todos, setTodos] = useState<AgentTodo[]>([])
  const [goalStatus, setGoalStatus] = useState<AgentGoalStatus | null>(null)
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null)
  const [queue, setQueue] = useState<QueuedMessage[]>([])
  // Paused: the queue holds messages but won't auto-fire when a run settles
  // (set when the user stops a run); the user resumes it explicitly.
  const [queuePaused, setQueuePaused] = useState(false)

  const agentRef = useRef<HttpAgent | null>(null)
  const agentThreadRef = useRef<string | null>(null)
  // Set by `startMode` and consumed by the next lazy thread-create in performSend.
  const pendingModeInitRef = useRef<ThreadModeInit | null>(null)
  const reconnectAbortRef = useRef<AbortController | null>(null)
  const currentAssistantId = useRef<string | null>(null)
  // Thread `send` is actively driving via the live POST stream. Set synchronously
  // so `loadConversation` can bail before it opens a second consumer for the same
  // run (see the guard in `loadConversation`).
  const sendingThreadRef = useRef<string | null>(null)
  // Thread currently being (or already) opened by `loadConversation`. Set
  // synchronously so a duplicate open of the same thread — e.g. StrictMode
  // double-invoking the URL effect, or a re-render firing it again — bails
  // instead of wiping the loaded messages ([]) and reloading, which yanks the
  // view off the bottom mid-stream.
  const loadedThreadRef = useRef<string | null>(null)

  // Latest values for use inside stable callbacks without re-binding them.
  const optionsRef = useRef(options)
  optionsRef.current = options
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const selectedThreadIdRef = useRef(selectedThreadId)
  selectedThreadIdRef.current = selectedThreadId
  const isStreamingRef = useRef(isStreaming)
  isStreamingRef.current = isStreaming
  // Monotonic token so a slow history load can't clobber a newer conversation.
  const loadSeq = useRef(0)

  // Authoritative queue mirror so the run-settle handler (a stale closure) can
  // drain the latest queue, plus a self-ref so it can re-enter the send path,
  // and a pause mirror the drain reads synchronously.
  const queueRef = useRef<QueuedMessage[]>([])
  const pausedRef = useRef(false)
  const performSendRef = useRef<((msg: QueuedMessage) => Promise<void>) | null>(
    null
  )
  const mountedRef = useRef(true)
  // Set on (re)mount too: StrictMode's mount→unmount→remount would otherwise
  // leave this false forever, so drainQueue would bail on every run settle.
  useEffect(() => {
    mountedRef.current = true
    return () => void (mountedRef.current = false)
  }, [])

  // Write both the queue mirror and state; an empty queue can't stay paused, so
  // reset the flag when it drains or is cleared.
  const setQueueSynced = useCallback((next: QueuedMessage[]) => {
    queueRef.current = next
    setQueue(next)
    if (next.length === 0 && pausedRef.current) {
      pausedRef.current = false
      setQueuePaused(false)
    }
  }, [])

  const removeQueued = useCallback(
    (id: string) =>
      setQueueSynced(queueRef.current.filter((m) => m.id !== id)),
    [setQueueSynced]
  )

  const editQueued = useCallback(
    (id: string, text: string) =>
      setQueueSynced(
        queueRef.current.map((m) => (m.id === id ? { ...m, text } : m))
      ),
    [setQueueSynced]
  )

  const clearQueue = useCallback(() => setQueueSynced([]), [setQueueSynced])

  // Send the next queued message (FIFO), re-entering the send path via the ref.
  // Reads pausedRef (not state) so a run's settle handler sees a pause set
  // mid-stream by stop().
  const drainQueue = useCallback(() => {
    if (!mountedRef.current || pausedRef.current) return
    const [next, ...rest] = queueRef.current
    if (!next) return
    setQueueSynced(rest)
    void performSendRef.current?.(next)
  }, [setQueueSynced])

  const resolveAssistantId = useCallback((messageId?: string) => {
    if (messageId) {
      currentAssistantId.current = messageId
      return messageId
    }
    if (!currentAssistantId.current) currentAssistantId.current = randomUUID()
    return currentAssistantId.current
  }, [])

  // Single place the AG-UI events touch the message list; both transports use it.
  const handlers = useMemo<ChatEventHandlers>(
    () => ({
      onTextStart: (messageId) => {
        const id = resolveAssistantId(messageId)
        setMessages((prev) => upsertAssistant(prev, id))
      },
      onTextContent: (messageId, content) => {
        const id = resolveAssistantId(messageId)
        setMessages((prev) => setAssistantContent(prev, id, content))
      },
      onReasoning: (messageId, content) => {
        const id = resolveAssistantId(messageId)
        setMessages((prev) => setReasoning(prev, id, content))
      },
      onReasoningEnd: (messageId) => {
        setMessages((prev) => finishReasoning(prev, messageId))
      },
      onToolStart: (parentMessageId, toolCallId, toolName) => {
        const id = resolveAssistantId(parentMessageId)
        setMessages((prev) =>
          addToolCall(prev, id, { id: toolCallId, name: toolName, args: "" })
        )
      },
      onToolArgs: (toolCallId, args) => {
        setMessages((prev) => setToolCallArgs(prev, toolCallId, args))
      },
      onToolResult: (toolCallId, result) => {
        setMessages((prev) => setToolCallResult(prev, toolCallId, result))
      },
      onTodos: (next) => setTodos(next),
      onGoalStatus: (next) => setGoalStatus(next),
      onError: (message) => setError(message),
    }),
    [resolveAssistantId]
  )

  const abortLocalStreams = useCallback(() => {
    agentRef.current?.abortRun()
    reconnectAbortRef.current?.abort()
    reconnectAbortRef.current = null
  }, [])

  // On unmount, tear down the local stream consumers so they stop calling
  // setState on a gone component. The server run is intentionally left alive to
  // rejoin later.
  useEffect(() => abortLocalStreams, [abortLocalStreams])

  const reconnectToRun = useCallback(
    (threadId: string) => {
      reconnectAbortRef.current?.abort()
      const controller = new AbortController()
      reconnectAbortRef.current = controller
      currentAssistantId.current = null
      setIsStreaming(true)

      consumeThreadStream(threadId, handlers, controller.signal)
        .catch((err: unknown) => {
          if (isAbortError(err)) return
          // A finished/absent run closes cleanly; only surface real failures.
          setError(err instanceof Error ? err.message : "Reconnect failed")
        })
        .finally(() => {
          if (reconnectAbortRef.current !== controller) return
          reconnectAbortRef.current = null
          currentAssistantId.current = null
          setIsStreaming(false)
          setMessages((prev) => finishStreaming(prev))
          drainQueue()
        })
    },
    [handlers, drainQueue]
  )

  const loadConversation = useCallback(
    async (threadId: string) => {
      // Already driving this exact thread via `send`? Opening it again would abort
      // the live POST stream and spin up a reconnect GET stream — two consumers of
      // one run, which duplicates the assistant bubble when the model emits no
      // message ids. This fires on first-send because `setSearchParams` flushes the
      // URL (via useSyncExternalStore) a render before `selectedThreadId` catches
      // up, so the URL effect's `cParam !== selectedThreadId` guard slips through.
      if (threadId === sendingThreadRef.current) return
      // Already opened (or opening) this exact thread: a duplicate call would
      // wipe the loaded messages and reload, detaching the view mid-stream.
      if (threadId === loadedThreadRef.current) return
      loadedThreadRef.current = threadId
      abortLocalStreams()
      const seq = ++loadSeq.current
      setSelectedThreadId(threadId)
      setError(null)
      setIsStreaming(false)
      setMessages([])
      // Queued messages belong to the conversation they were typed in.
      setQueueSynced([])
      // A reconnect replays this thread's buffered `todos` events and rebuilds
      // the list; clear first so a stale list from the previous thread can't linger.
      setTodos([])
      setGoalStatus(null)
      currentAssistantId.current = null
      // Point the send transport at the opened thread.
      agentRef.current = createThreadAgent(threadId)
      agentThreadRef.current = threadId

      try {
        const persisted = await threadsApi.messages(threadId)
        if (loadSeq.current !== seq) return // superseded by a newer open
        setMessages(toChatMessages(persisted, threadId))
      } catch (err) {
        if (loadSeq.current !== seq) return
        setError(err instanceof Error ? err.message : "Failed to load conversation")
      }

      const { reconnect, activeRuns } = optionsRef.current
      if (reconnect && activeRuns?.has(threadId)) {
        reconnectToRun(threadId)
      }
    },
    [abortLocalStreams, reconnectToRun, setQueueSynced]
  )

  const startNewConversation = useCallback(() => {
    abortLocalStreams()
    loadSeq.current++
    agentRef.current = null
    agentThreadRef.current = null
    currentAssistantId.current = null
    // Abandoned any in-flight send; re-opening that thread should reconnect, not bail.
    sendingThreadRef.current = null
    loadedThreadRef.current = null
    setSelectedThreadId(null)
    setMessages([])
    setTodos([])
    setGoalStatus(null)
    setError(null)
    setIsStreaming(false)
    setQueueSynced([])
  }, [abortLocalStreams, setQueueSynced])

  // Streams a single message end to end. Reads no composer state, so it serves
  // both a live submit and a message drained off the queue. Drains the next
  // queued message once this run settles.
  const performSend = useCallback(
    async ({ text: trimmed, attachments, turnIntent, kind }: QueuedMessage) => {
      const { workspaceId, agentId } = optionsRef.current
      if (!workspaceId || !agentId) {
        setError("Pick an agent before sending a message.")
        return
      }

      // Lazily create the thread on first send so "New conversation" leaves no
      // orphan threads behind if the user never sends anything. A pending mode
      // init (set by `startMode`) makes the new thread a plan/goal thread.
      let threadId = selectedThreadIdRef.current
      if (!threadId) {
        const modeInit = pendingModeInitRef.current
        pendingModeInitRef.current = null
        try {
          const thread = await threadsApi.create({
            workspace_id: workspaceId,
            agent_id: agentId,
            title: modeInit
              ? modeInit.goal.slice(0, 60) || "New conversation"
              : "New conversation",
            ...(modeInit
              ? {
                  mode: modeInit.mode,
                  goal: modeInit.goal,
                  success_criteria: modeInit.successCriteria,
                  max_iterations: modeInit.maxIterations,
                }
              : {}),
          })
          threadId = thread.id
          selectedThreadIdRef.current = thread.id
          // Claim this thread as ours before the URL update below, so the
          // resulting `loadConversation` bails instead of opening a rival stream.
          sendingThreadRef.current = thread.id
          setSelectedThreadId(thread.id)
          optionsRef.current.onThreadCreated?.(thread)
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to start conversation")
          return
        }
      }
      sendingThreadRef.current = threadId

      if (!agentRef.current || agentThreadRef.current !== threadId) {
        agentRef.current = createThreadAgent(threadId)
        agentThreadRef.current = threadId
      }
      const agent = agentRef.current
      // Seed the transport with the current history, then append the new turn.
      agent.setMessages(toAgentMessages(messagesRef.current))

      // Expand `@/files/…` mention tokens into plain workspace-relative paths so
      // the agent reads them as references, not an absolute `/files/` path.
      const outgoing = expandMentionTokens(trimmed)
      const userMessage: ChatMessage = {
        id: randomUUID(),
        role: "user",
        content: outgoing,
        toolCalls: [],
        kind,
        attachments: attachments.map((a) => ({
          url: a.dataUrl,
          mimeType: a.mimeType,
          name: a.name,
        })),
      }
      setMessages((prev) => [...prev, userMessage])
      agent.addMessage({
        id: userMessage.id,
        role: "user",
        content: buildUserContent(outgoing, attachments),
      } as Message)

      currentAssistantId.current = null
      setIsStreaming(true)
      setError(null)

      try {
        await agent.runAgent(
          // Carry the per-turn intent so the backend can build a read-only
          // ("ask") agent for this turn. Plan/goal threads ignore it.
          { forwardedProps: { turn: turnIntent } },
          {
            onTextMessageStartEvent: ({ event }) =>
              handlers.onTextStart(event.messageId),
            onTextMessageContentEvent: ({ event, textMessageBuffer }) =>
              handlers.onTextContent(event.messageId, textMessageBuffer),
            onReasoningMessageContentEvent: ({ event, reasoningMessageBuffer }) =>
              handlers.onReasoning(event.messageId, reasoningMessageBuffer),
            onReasoningMessageEndEvent: ({ event }) =>
              handlers.onReasoningEnd(event.messageId),
            onToolCallStartEvent: ({ event }) =>
              handlers.onToolStart(
                event.parentMessageId,
                event.toolCallId,
                event.toolCallName
              ),
            onToolCallArgsEvent: ({ event, toolCallBuffer }) =>
              handlers.onToolArgs(event.toolCallId, toolCallBuffer),
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
            // The AG-UI client turns an aborted fetch (switch/stop) into a
            // RUN_ERROR event with code "abort" rather than rejecting runAgent, so
            // the try/catch below never sees it. Drop it here — it's expected, not
            // a failure — otherwise "BodyStreamBuffer was aborted" paints as an error.
            onRunErrorEvent: ({ event }) => {
              if (event.code === "abort" || isAbortError(event.rawEvent)) return
              handlers.onError(event.message)
            },
          }
        )
      } catch (err) {
        // An aborted run is expected — switching conversation or hitting stop
        // aborts this send's local stream. Never surface it as an error (the
        // `selectedThreadIdRef` guard alone is racy: the ref lags the switch by a
        // render, so the abort rejection can slip through and paint onto the new
        // conversation). Only surface the error on the conversation it belongs to.
        if (!isAbortError(err) && selectedThreadIdRef.current === threadId) {
          setError(err instanceof Error ? err.message : "Chat request failed")
        }
      } finally {
        if (sendingThreadRef.current === threadId) sendingThreadRef.current = null
        // Only reset shared streaming state if this send still owns the surface.
        // If the user switched conversation mid-send, the newer conversation now
        // owns isStreaming/messages/currentAssistantId and must not be clobbered.
        if (selectedThreadIdRef.current === threadId) {
          setIsStreaming(false)
          currentAssistantId.current = null
          setMessages((prev) => finishStreaming(prev))
        }
        // Chain the next queued message once this run settles. A no-op when the
        // queue is empty, paused (stopped run), or cleared by a conversation
        // switch, so it never leaks into another thread.
        drainQueue()
      }
    },
    [handlers, drainQueue]
  )
  performSendRef.current = performSend

  const send = useCallback(
    async (
      text: string,
      attachments: PendingAttachment[] = [],
      turnIntent: TurnIntent = "chat",
      kind: MessageKind = turnIntent
    ) => {
      const trimmed = text.trim()
      if (!trimmed && attachments.length === 0) return
      const msg: QueuedMessage = {
        id: randomUUID(),
        text: trimmed,
        attachments,
        turnIntent,
        kind,
      }
      // Append while a run is streaming, or while a pending queue already exists,
      // so new messages join the batch in order rather than jumping ahead.
      if (isStreamingRef.current || queueRef.current.length > 0) {
        setQueueSynced([...queueRef.current, msg])
        return
      }
      await performSend(msg)
    },
    [performSend, setQueueSynced]
  )

  // Enter plan/goal mode on a fresh conversation. Routes through `performSend`'s
  // lazy-create so the thread is created and claimed (sendingThreadRef) before
  // the URL updates — the same guard that stops `loadConversation` from wiping
  // the just-sent objective and streamed reply.
  const startMode = useCallback(
    async (text: string, init: ThreadModeInit) => {
      const trimmed = text.trim()
      if (!trimmed) return
      pendingModeInitRef.current = init
      await performSend({
        id: randomUUID(),
        text: trimmed,
        attachments: [],
        turnIntent: "chat",
        kind: init.mode,
      })
    },
    [performSend]
  )

  // Steer a running goal without opening a second run: POST the message to the
  // interject endpoint (the backend buffers it into the loop's next turn) and
  // optimistically append it to the thread so the user sees it land immediately.
  const interject = useCallback(async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    const threadId = selectedThreadIdRef.current
    if (!threadId) return
    const outgoing = expandMentionTokens(trimmed)
    const userMessage: ChatMessage = {
      id: randomUUID(),
      role: "user",
      content: outgoing,
      toolCalls: [],
      kind: "goal",
    }
    setMessages((prev) => [...prev, userMessage])
    try {
      await threadsApi.interjectGoal(threadId, outgoing)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send message")
    }
  }, [])

  // Resume a paused queue: fire it now (the rest auto-drain as each run settles).
  const resumeQueue = useCallback(() => {
    pausedRef.current = false
    setQueuePaused(false)
    drainQueue()
  }, [drainQueue])

  const stop = useCallback(() => {
    // Pause (don't drop) any queued messages so the settling stream's drain
    // doesn't auto-fire them; the user resumes the queue explicitly.
    if (queueRef.current.length > 0) {
      pausedRef.current = true
      setQueuePaused(true)
    }
    abortLocalStreams()
    setIsStreaming(false)
    setMessages((prev) => finishStreaming(prev))
    // Aborting the local stream drops us before the server's `stopped` status
    // event lands, so optimistically mark a live goal as stopped — otherwise the
    // "Stop goal" button (gated on status === "running") never clears and the run
    // looks like it's still going. The server confirms via the persisted state.
    setGoalStatus((prev) =>
      prev && prev.status === "running" ? { ...prev, status: "stopped" } : prev
    )
    const threadId = selectedThreadIdRef.current
    if (threadId) {
      // Tell the server to cancel the decoupled run; 404 means nothing running.
      threadsApi.stop(threadId).catch(() => {})
    }
  }, [abortLocalStreams])

  return {
    selectedThreadId,
    messages,
    todos,
    goalStatus,
    isStreaming,
    error,
    queue,
    queuePaused,
    send,
    startMode,
    interject,
    stop,
    removeQueued,
    editQueued,
    resumeQueue,
    clearQueue,
    loadConversation,
    startNewConversation,
  }
}
