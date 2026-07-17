import type { ChatMessage, ChatToolCall } from "./types"

/**
 * Pure helpers that map AG-UI streaming events onto the UI message list.
 * Each returns a new array so they compose cleanly inside React state updates.
 */

function emptyAssistant(id: string): ChatMessage {
  return { id, role: "assistant", content: "", toolCalls: [], streaming: true }
}

export function upsertAssistant(
  messages: ChatMessage[],
  messageId: string
): ChatMessage[] {
  if (messages.some((m) => m.id === messageId)) return messages
  return [...messages, emptyAssistant(messageId)]
}

export function setAssistantContent(
  messages: ChatMessage[],
  messageId: string,
  content: string
): ChatMessage[] {
  let found = false
  const next = messages.map((m) => {
    if (m.id !== messageId) return m
    found = true
    return { ...m, content, streaming: true }
  })
  if (found) return next
  return [...next, { ...emptyAssistant(messageId), content }]
}

export function setReasoning(
  messages: ChatMessage[],
  messageId: string,
  reasoning: string
): ChatMessage[] {
  let found = false
  const next = messages.map((m) => {
    if (m.id !== messageId) return m
    found = true
    return { ...m, reasoning, streaming: true }
  })
  if (found) return next
  return [...next, { ...emptyAssistant(messageId), reasoning }]
}

/** Marks a turn's reasoning phase complete so its block can auto-collapse while
 *  the rest of the turn (answer/tools) is still streaming. */
export function finishReasoning(
  messages: ChatMessage[],
  messageId: string
): ChatMessage[] {
  return messages.map((m) =>
    m.id === messageId ? { ...m, reasoningDone: true } : m
  )
}

export function addToolCall(
  messages: ChatMessage[],
  messageId: string,
  toolCall: ChatToolCall
): ChatMessage[] {
  let found = false
  const next = messages.map((m) => {
    if (m.id !== messageId) return m
    found = true
    if (m.toolCalls.some((t) => t.id === toolCall.id)) return m
    return { ...m, toolCalls: [...m.toolCalls, toolCall] }
  })
  if (found) return next
  return [
    ...next,
    { ...emptyAssistant(messageId), toolCalls: [toolCall] },
  ]
}

function updateToolCall(
  messages: ChatMessage[],
  toolCallId: string,
  patch: Partial<ChatToolCall>
): ChatMessage[] {
  return messages.map((m) => {
    if (!m.toolCalls.some((t) => t.id === toolCallId)) return m
    return {
      ...m,
      toolCalls: m.toolCalls.map((t) =>
        t.id === toolCallId ? { ...t, ...patch } : t
      ),
    }
  })
}

export function setToolCallArgs(
  messages: ChatMessage[],
  toolCallId: string,
  args: string
): ChatMessage[] {
  return updateToolCall(messages, toolCallId, { args })
}

export function setToolCallResult(
  messages: ChatMessage[],
  toolCallId: string,
  result: string
): ChatMessage[] {
  return updateToolCall(messages, toolCallId, { result })
}

export function finishStreaming(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) =>
    m.streaming ? { ...m, streaming: false } : m
  )
}
