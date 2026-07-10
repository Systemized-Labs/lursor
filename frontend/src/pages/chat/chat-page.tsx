import { ArrowLeft, Bot } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { Link, useParams } from "react-router-dom"

import type { ThreadMessage } from "@/api/types"
import { useThread, useThreadMessages } from "@/api/threads"
import type { ChatMessage } from "@/agui/types"
import { useAgentChat } from "@/agui/useAgentChat"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ChatComposer } from "@/components/chat/ChatComposer"
import { ChatMessageList } from "@/components/chat/ChatMessageList"

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
  const containerRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const isUserScrolledUpRef = useRef(false)
  const [isAtBottom, setIsAtBottom] = useState(true)

  useEffect(() => {
    if (threadId && messagesQuery.data && seededThreadId.current !== threadId) {
      reset(toChatMessages(messagesQuery.data))
      seededThreadId.current = threadId
    }
  }, [threadId, messagesQuery.data, reset])

  // Track whether the user has scrolled away from the bottom.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      const scrolledUp = distFromBottom > 150
      isUserScrolledUpRef.current = scrolledUp
      setIsAtBottom(!scrolledUp)
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
  }, [messages.length > 0])

  // Auto-scroll to the bottom on new content unless the user has scrolled up.
  useEffect(() => {
    if (!isUserScrolledUpRef.current) {
      endRef.current?.scrollIntoView({ behavior: "smooth" })
    }
  }, [messages])

  const scrollToBottom = useCallback(() => {
    isUserScrolledUpRef.current = false
    setIsAtBottom(true)
    endRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [])

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
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-card">
      {/* Header */}
      <div className="flex items-center gap-3 border-b bg-card/60 px-4 py-3 backdrop-blur-sm">
        <Button asChild variant="ghost" size="icon" className="shrink-0">
          <Link to={backTo} aria-label="Back to workspace">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="relative flex-shrink-0">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 ring-1 ring-primary/20">
            <Bot className="h-4 w-4 text-primary" />
          </div>
          <span
            className={cn(
              "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-card transition-colors",
              isStreaming ? "bg-primary animate-pulse" : "bg-success"
            )}
          />
        </div>
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-sm font-semibold text-foreground">
            {threadQuery.data?.title ?? "Chat"}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {isStreaming ? "Thinking…" : "Online"}
          </span>
        </div>
      </div>

      <ChatMessageList
        messages={messages}
        endRef={endRef}
        containerRef={containerRef}
        className="flex-1 space-y-5 overflow-y-auto px-4 py-5 sm:px-6"
        isLoadingMessages={messagesQuery.isLoading}
        renderIcons
        showScrollToBottom={!isAtBottom}
        onScrollToBottom={scrollToBottom}
        empty={
          <div className="flex h-full items-center justify-center">
            <div className="space-y-3 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/15">
                <Bot className="h-7 w-7 text-primary" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-semibold text-foreground">
                  {threadQuery.data?.title ?? "Start the conversation"}
                </p>
                <p className="mx-auto max-w-[15rem] text-xs text-muted-foreground">
                  Send the first message below to get started.
                </p>
              </div>
            </div>
          </div>
        }
      />

      {error ? (
        <p className="px-4 pb-1 text-sm text-destructive">{error}</p>
      ) : null}

      <ChatComposer
        input={draft}
        onInputChange={setDraft}
        onKeyDown={handleKeyDown}
        onSend={() => void handleSend()}
        onStop={stop}
        isSending={isStreaming}
        disabled={!threadId}
      />
    </div>
  )
}
