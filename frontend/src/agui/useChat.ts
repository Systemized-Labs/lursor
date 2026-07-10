import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { HttpAgent, type Message, randomUUID } from "@ag-ui/client"

import type { Thread, ThreadMessage } from "@/api/types"
import { threadsApi } from "@/api/threads"

import { createThreadAgent } from "./agent"
import {
  addToolCall,
  finishStreaming,
  setAssistantContent,
  setToolCallArgs,
  setToolCallResult,
  upsertAssistant,
} from "./reducer"
import { consumeThreadStream, type ChatEventHandlers } from "./stream-reader"
import type { ChatMessage } from "./types"

/** Maps persisted thread messages into the UI message shape. */
export function toChatMessages(messages: ThreadMessage[]): ChatMessage[] {
  return messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    // `tool_calls` is an opaque JSON object by default; narrow before mapping.
    toolCalls: Array.isArray(m.tool_calls)
      ? m.tool_calls.map((tc) => ({ id: tc.id, name: tc.name, args: tc.arguments }))
      : [],
  }))
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

export interface UseChat {
  selectedThreadId: string | null
  messages: ChatMessage[]
  isStreaming: boolean
  error: string | null
  send: (text: string) => Promise<void>
  stop: () => void
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
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null)

  const agentRef = useRef<HttpAgent | null>(null)
  const agentThreadRef = useRef<string | null>(null)
  const reconnectAbortRef = useRef<AbortController | null>(null)
  const currentAssistantId = useRef<string | null>(null)
  // Thread `send` is actively driving via the live POST stream. Set synchronously
  // so `loadConversation` can bail before it opens a second consumer for the same
  // run (see the guard in `loadConversation`).
  const sendingThreadRef = useRef<string | null>(null)

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
          if (err instanceof DOMException && err.name === "AbortError") return
          // A finished/absent run closes cleanly; only surface real failures.
          setError(err instanceof Error ? err.message : "Reconnect failed")
        })
        .finally(() => {
          if (reconnectAbortRef.current !== controller) return
          reconnectAbortRef.current = null
          currentAssistantId.current = null
          setIsStreaming(false)
          setMessages((prev) => finishStreaming(prev))
        })
    },
    [handlers]
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
      abortLocalStreams()
      const seq = ++loadSeq.current
      setSelectedThreadId(threadId)
      setError(null)
      setIsStreaming(false)
      setMessages([])
      currentAssistantId.current = null
      // Point the send transport at the opened thread.
      agentRef.current = createThreadAgent(threadId)
      agentThreadRef.current = threadId

      try {
        const persisted = await threadsApi.messages(threadId)
        if (loadSeq.current !== seq) return // superseded by a newer open
        setMessages(toChatMessages(persisted))
      } catch (err) {
        if (loadSeq.current !== seq) return
        setError(err instanceof Error ? err.message : "Failed to load conversation")
      }

      const { reconnect, activeRuns } = optionsRef.current
      if (reconnect && activeRuns?.has(threadId)) {
        reconnectToRun(threadId)
      }
    },
    [abortLocalStreams, reconnectToRun]
  )

  const startNewConversation = useCallback(() => {
    abortLocalStreams()
    loadSeq.current++
    agentRef.current = null
    agentThreadRef.current = null
    currentAssistantId.current = null
    // Abandoned any in-flight send; re-opening that thread should reconnect, not bail.
    sendingThreadRef.current = null
    setSelectedThreadId(null)
    setMessages([])
    setError(null)
    setIsStreaming(false)
  }, [abortLocalStreams])

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (!trimmed || isStreamingRef.current) return
      const { workspaceId, agentId } = optionsRef.current
      if (!workspaceId || !agentId) {
        setError("Pick an agent before sending a message.")
        return
      }

      // Lazily create the thread on first send so "New conversation" leaves no
      // orphan threads behind if the user never sends anything.
      let threadId = selectedThreadIdRef.current
      if (!threadId) {
        try {
          const thread = await threadsApi.create({
            workspace_id: workspaceId,
            agent_id: agentId,
            title: "New conversation",
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

      const userMessage: ChatMessage = {
        id: randomUUID(),
        role: "user",
        content: trimmed,
        toolCalls: [],
      }
      setMessages((prev) => [...prev, userMessage])
      agent.addMessage({ id: userMessage.id, role: "user", content: trimmed })

      currentAssistantId.current = null
      setIsStreaming(true)
      setError(null)

      try {
        await agent.runAgent(
          {},
          {
            onTextMessageStartEvent: ({ event }) =>
              handlers.onTextStart(event.messageId),
            onTextMessageContentEvent: ({ event, textMessageBuffer }) =>
              handlers.onTextContent(event.messageId, textMessageBuffer),
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
            onRunErrorEvent: ({ event }) => handlers.onError(event.message),
          }
        )
      } catch (err) {
        // Only surface the error on the conversation this send belongs to; a
        // switch mid-send aborts this run and must not paint an error onto the
        // conversation the user moved to.
        if (selectedThreadIdRef.current === threadId) {
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
      }
    },
    [handlers]
  )

  const stop = useCallback(() => {
    abortLocalStreams()
    setIsStreaming(false)
    setMessages((prev) => finishStreaming(prev))
    const threadId = selectedThreadIdRef.current
    if (threadId) {
      // Tell the server to cancel the decoupled run; 404 means nothing running.
      threadsApi.stop(threadId).catch(() => {})
    }
  }, [abortLocalStreams])

  return {
    selectedThreadId,
    messages,
    isStreaming,
    error,
    send,
    stop,
    loadConversation,
    startNewConversation,
  }
}
