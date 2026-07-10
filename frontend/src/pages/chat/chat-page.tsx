import { ArrowLeft, Send, Square } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Link, useParams } from "react-router-dom"

import type { ThreadMessage } from "@/api/types"
import { useThread, useThreadMessages } from "@/api/threads"
import type { ChatMessage } from "@/agui/types"
import { useAgentChat } from "@/agui/useAgentChat"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { ChatMessageItem } from "./chat-message-item"

function toChatMessages(messages: ThreadMessage[]): ChatMessage[] {
  return messages.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    // The backend persists `tool_calls` as an opaque JSON object (default `{}`),
    // so guard against anything that isn't the expected array before mapping.
    toolCalls: Array.isArray(m.tool_calls)
      ? m.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.name,
          args: tc.arguments,
        }))
      : [],
  }))
}

export function ChatPage() {
  const { workspaceId, threadId } = useParams<{
    workspaceId: string
    threadId: string
  }>()

  const threadQuery = useThread(threadId)
  const messagesQuery = useThreadMessages(threadId)
  const { messages, isStreaming, error, send, stop, reset } = useAgentChat(
    threadId ?? ""
  )

  const [draft, setDraft] = useState("")
  const seededThreadId = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (
      threadId &&
      messagesQuery.data &&
      seededThreadId.current !== threadId
    ) {
      reset(toChatMessages(messagesQuery.data))
      seededThreadId.current = threadId
    }
  }, [threadId, messagesQuery.data, reset])

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    })
  }, [messages])

  async function handleSend() {
    const text = draft
    setDraft("")
    await send(text)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  const backTo = workspaceId ? `/workspaces/${workspaceId}` : "/workspaces"

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button asChild variant="ghost" size="icon" className="shrink-0">
            <Link to={backTo} aria-label="Back to workspace">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
          <h1 className="truncate text-lg font-semibold text-foreground">
            {threadQuery.data?.title ?? "Chat"}
          </h1>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 space-y-4 overflow-y-auto rounded-lg border bg-card p-4"
      >
        {messagesQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading messages…</p>
        ) : messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No messages yet. Send the first message below.
          </p>
        ) : (
          messages.map((message) => (
            <ChatMessageItem key={message.id} message={message} />
          ))
        )}
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="flex items-end gap-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Send a message…"
          className="min-h-[52px] flex-1 resize-none"
          disabled={!threadId}
        />
        {isStreaming ? (
          <Button
            variant="secondary"
            className="h-[52px]"
            onClick={stop}
            aria-label="Stop"
          >
            <Square className="h-4 w-4" />
            Stop
          </Button>
        ) : (
          <Button
            className="h-[52px]"
            onClick={() => void handleSend()}
            disabled={!draft.trim() || !threadId}
            aria-label="Send"
          >
            <Send className="h-4 w-4" />
            Send
          </Button>
        )}
      </div>
    </div>
  )
}
