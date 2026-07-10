import { useCallback, useEffect, useRef, useState } from "react"
import { HttpAgent, type Message, randomUUID } from "@ag-ui/client"

import { createThreadAgent } from "./agent"
import {
  addToolCall,
  finishStreaming,
  setAssistantContent,
  setToolCallArgs,
  setToolCallResult,
  upsertAssistant,
} from "./reducer"
import type { ChatMessage } from "./types"

/**
 * Maps UI messages to AG-UI history messages for seeding the agent. Tool-role
 * messages are omitted from the transport history (they still render in the UI).
 */
function toAgentMessages(messages: ChatMessage[]): Message[] {
  const result: Message[] = []
  for (const m of messages) {
    if (m.role === "user") {
      result.push({ id: m.id, role: "user", content: m.content })
    } else if (m.role === "assistant") {
      result.push({ id: m.id, role: "assistant", content: m.content })
    } else if (m.role === "system") {
      result.push({ id: m.id, role: "system", content: m.content })
    }
  }
  return result
}

export interface UseAgentChat {
  messages: ChatMessage[]
  isStreaming: boolean
  error: string | null
  send: (text: string) => Promise<void>
  stop: () => void
  reset: (initial: ChatMessage[]) => void
}

/**
 * Isolated hook wrapping the AG-UI `HttpAgent`. It runs the agent against the
 * thread chat endpoint and maps streaming events onto a UI message list.
 */
export function useAgentChat(threadId: string): UseAgentChat {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const agentRef = useRef<HttpAgent | null>(null)
  const currentAssistantId = useRef<string | null>(null)

  useEffect(() => {
    agentRef.current = createThreadAgent(threadId)
    return () => {
      agentRef.current?.abortRun()
      agentRef.current = null
    }
  }, [threadId])

  const reset = useCallback((initial: ChatMessage[]) => {
    setMessages(initial)
    const agent = agentRef.current
    if (agent) {
      agent.setMessages(toAgentMessages(initial))
    }
  }, [])

  const resolveAssistantId = useCallback((parentMessageId?: string) => {
    if (parentMessageId) {
      currentAssistantId.current = parentMessageId
      return parentMessageId
    }
    if (!currentAssistantId.current) {
      currentAssistantId.current = randomUUID()
    }
    return currentAssistantId.current
  }, [])

  const send = useCallback(
    async (text: string) => {
      const agent = agentRef.current
      const trimmed = text.trim()
      if (!agent || isStreaming || !trimmed) return

      const userMessage: ChatMessage = {
        id: randomUUID(),
        role: "user",
        content: trimmed,
        toolCalls: [],
      }
      setMessages((prev) => [...prev, userMessage])
      agent.addMessage({
        id: userMessage.id,
        role: "user",
        content: trimmed,
      })

      currentAssistantId.current = null
      setIsStreaming(true)
      setError(null)

      try {
        await agent.runAgent(
          {},
          {
            onTextMessageStartEvent: ({ event }) => {
              const id = resolveAssistantId(event.messageId)
              setMessages((prev) => upsertAssistant(prev, id))
            },
            onTextMessageContentEvent: ({ event, textMessageBuffer }) => {
              const id = resolveAssistantId(event.messageId)
              setMessages((prev) =>
                setAssistantContent(prev, id, textMessageBuffer)
              )
            },
            onToolCallStartEvent: ({ event }) => {
              const id = resolveAssistantId(event.parentMessageId)
              setMessages((prev) =>
                addToolCall(prev, id, {
                  id: event.toolCallId,
                  name: event.toolCallName,
                  args: "",
                })
              )
            },
            onToolCallArgsEvent: ({ event, toolCallBuffer }) => {
              setMessages((prev) =>
                setToolCallArgs(prev, event.toolCallId, toolCallBuffer)
              )
            },
            onToolCallResultEvent: ({ event }) => {
              setMessages((prev) =>
                setToolCallResult(prev, event.toolCallId, event.content)
              )
            },
            onRunErrorEvent: ({ event }) => {
              setError(event.message)
            },
          }
        )
      } catch (err) {
        setError(err instanceof Error ? err.message : "Chat request failed")
      } finally {
        setIsStreaming(false)
        currentAssistantId.current = null
        setMessages((prev) => finishStreaming(prev))
      }
    },
    [isStreaming, resolveAssistantId]
  )

  const stop = useCallback(() => {
    agentRef.current?.abortRun()
    setIsStreaming(false)
    setMessages((prev) => finishStreaming(prev))
  }, [])

  return { messages, isStreaming, error, send, stop, reset }
}
