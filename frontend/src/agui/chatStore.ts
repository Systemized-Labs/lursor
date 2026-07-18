import { createContext, useContext } from "react"
import { useStore } from "zustand"
import { createStore, type StoreApi } from "zustand/vanilla"

import type { MessageKind, TurnIntent } from "@/api/types"
import type {
  AgentGoalStatus,
  AgentTodo,
  ChatMessage,
  ChatToolCall,
  PendingAttachment,
} from "@/agui/types"

/**
 * A message the user submitted while a run was still streaming. Queued messages
 * auto-send (FIFO) once the active run settles. Lives here (not the engine) so
 * the store is the single source of truth the composer subscribes to.
 */
export interface QueuedMessage {
  id: string
  text: string
  attachments: PendingAttachment[]
  /** Per-turn intent captured when the message was submitted (defaults "chat"). */
  turnIntent: TurnIntent
  /** Display kind for the history badge (chat/ask/plan/goal). */
  kind: MessageKind
}

/**
 * The normalized chat state. Messages are keyed by id (`byId`) with a separate
 * render order (`order`) so a streamed token mutates exactly one entry: only the
 * component subscribed to that id re-renders, and the timeline (subscribed to
 * `order`) never re-renders mid-stream. Keeping messages normalized (rather than
 * one `ChatMessage[]` in one hook) is what stops a token from re-rendering — and
 * flashing — the whole timeline.
 */
export interface ChatState {
  order: string[]
  byId: Record<string, ChatMessage>
  todos: AgentTodo[]
  goalStatus: AgentGoalStatus | null
  isStreaming: boolean
  error: string | null
  queue: QueuedMessage[]
  /** The queue holds messages but won't auto-drain (set when a run is stopped). */
  queuePaused: boolean
  selectedThreadId: string | null
}

export interface ChatActions {
  /** Replace the whole message list (opening a conversation's history). */
  resetMessages(messages: ChatMessage[]): void
  /** Append a fully-formed message (a user turn or optimistic interjection). */
  appendMessage(message: ChatMessage): void
  /** Ensure an empty assistant message exists for `id`. */
  upsertAssistant(id: string): void
  setContent(id: string, content: string): void
  setReasoning(id: string, reasoning: string): void
  finishReasoning(id: string): void
  addToolCall(id: string, toolCall: ChatToolCall): void
  setToolArgs(toolCallId: string, args: string): void
  setToolResult(toolCallId: string, result: string): void
  /** Clear the `streaming` flag on every message (a run settled). */
  finishStreaming(): void
  setTodos(todos: AgentTodo[]): void
  setGoalStatus(next: AgentGoalStatus | null): void
  markGoalStopped(): void
  setIsStreaming(value: boolean): void
  setError(error: string | null): void
  /** Replace the queue; an empty queue can't stay paused, so the flag resets. */
  setQueue(queue: QueuedMessage[]): void
  setQueuePaused(value: boolean): void
  setSelectedThreadId(id: string | null): void
}

export type ChatStore = StoreApi<ChatState & ChatActions>

function emptyAssistant(id: string): ChatMessage {
  return { id, role: "assistant", content: "", toolCalls: [], streaming: true }
}

/** All messages in render order — reconstructed from the normalized state. */
export function selectMessages(state: ChatState): ChatMessage[] {
  return state.order.map((id) => state.byId[id]).filter(Boolean)
}

export function createChatStore(): ChatStore {
  return createStore<ChatState & ChatActions>((set, get) => {
    /** Rewrites one message, creating a new `byId` so subscribers to that id
     *  re-render while every other entry keeps its reference (no re-render). */
    const patch = (id: string, next: ChatMessage) =>
      set((s) => ({ byId: { ...s.byId, [id]: next } }))

    /** Ensures an assistant message exists, returning the current entry. */
    const ensureAssistant = (id: string): ChatMessage => {
      const existing = get().byId[id]
      if (existing) return existing
      const created = emptyAssistant(id)
      set((s) => ({ order: [...s.order, id], byId: { ...s.byId, [id]: created } }))
      return created
    }

    return {
      order: [],
      byId: {},
      todos: [],
      goalStatus: null,
      isStreaming: false,
      error: null,
      queue: [],
      queuePaused: false,
      selectedThreadId: null,

      resetMessages: (messages) =>
        set(() => ({
          order: messages.map((m) => m.id),
          byId: Object.fromEntries(messages.map((m) => [m.id, m])),
        })),

      appendMessage: (message) =>
        set((s) => ({
          order: [...s.order, message.id],
          byId: { ...s.byId, [message.id]: message },
        })),

      upsertAssistant: (id) => {
        ensureAssistant(id)
      },

      setContent: (id, content) => {
        const m = ensureAssistant(id)
        patch(id, { ...m, content, streaming: true })
      },

      setReasoning: (id, reasoning) => {
        const m = ensureAssistant(id)
        patch(id, { ...m, reasoning, streaming: true })
      },

      finishReasoning: (id) => {
        const m = get().byId[id]
        if (m) patch(id, { ...m, reasoningDone: true })
      },

      addToolCall: (id, toolCall) => {
        const m = ensureAssistant(id)
        if (m.toolCalls.some((t) => t.id === toolCall.id)) return
        patch(id, { ...m, toolCalls: [...m.toolCalls, toolCall] })
      },

      setToolArgs: (toolCallId, args) => {
        const { byId } = get()
        for (const id of get().order) {
          const m = byId[id]
          if (!m?.toolCalls.some((t) => t.id === toolCallId)) continue
          patch(id, {
            ...m,
            toolCalls: m.toolCalls.map((t) =>
              t.id === toolCallId ? { ...t, args } : t
            ),
          })
          return
        }
      },

      setToolResult: (toolCallId, result) => {
        const { byId } = get()
        for (const id of get().order) {
          const m = byId[id]
          if (!m?.toolCalls.some((t) => t.id === toolCallId)) continue
          patch(id, {
            ...m,
            toolCalls: m.toolCalls.map((t) =>
              t.id === toolCallId ? { ...t, result } : t
            ),
          })
          return
        }
      },

      finishStreaming: () =>
        set((s) => {
          let changed = false
          const byId = { ...s.byId }
          for (const id of s.order) {
            const m = byId[id]
            if (m?.streaming) {
              byId[id] = { ...m, streaming: false }
              changed = true
            }
          }
          return changed ? { byId } : {}
        }),

      setTodos: (todos) => set({ todos }),
      setGoalStatus: (goalStatus) => set({ goalStatus }),
      markGoalStopped: () =>
        set((s) => ({
          goalStatus:
            s.goalStatus && s.goalStatus.status === "running"
              ? { ...s.goalStatus, status: "stopped" }
              : s.goalStatus,
        })),
      setIsStreaming: (isStreaming) => set({ isStreaming }),
      setError: (error) => set({ error }),
      setQueue: (queue) =>
        set((s) => ({
          queue,
          queuePaused: queue.length === 0 ? false : s.queuePaused,
        })),
      setQueuePaused: (queuePaused) => set({ queuePaused }),
      setSelectedThreadId: (selectedThreadId) => set({ selectedThreadId }),
    }
  })
}

// --- React binding ---------------------------------------------------------

const ChatStoreContext = createContext<ChatStore | null>(null)

export const ChatStoreProvider = ChatStoreContext.Provider

/** The store instance for the surrounding chat surface. */
export function useChatStoreApi(): ChatStore {
  const store = useContext(ChatStoreContext)
  if (!store) throw new Error("useChatStoreApi must be used within ChatStoreProvider")
  return store
}

/** Subscribe to a slice of chat state. Re-renders only when the slice changes. */
export function useChatSelector<T>(selector: (state: ChatState) => T): T {
  return useStore(useChatStoreApi(), selector)
}

/** Subscribe to a single message. Only this subscriber re-renders when that
 *  message's tokens/tools update — the timeline and sibling rows are untouched. */
export function useChatMessage(id: string): ChatMessage | undefined {
  return useChatSelector((s) => s.byId[id])
}
