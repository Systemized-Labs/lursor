import { useEffect, useRef, useState } from "react"
import { Bot, Copy, Check } from "lucide-react"

import { cn } from "@/lib/utils"
import { renderWithIcons } from "@/lib/emoji-icons"
import { MarkdownRenderer } from "@/components/ui/markdown-renderer"
import { ChatToolCalls } from "@/components/chat/ChatToolCalls"
import { ChatFilesChanged } from "@/components/chat/ChatFilesChanged"
import type { ChatMessage } from "@/agui/types"

/** Hover action button that copies a message's text to the clipboard. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      title={copied ? "Copied" : "Copy"}
      aria-label="Copy message"
      className="flex-shrink-0 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:opacity-100"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  )
}

// Fraction of the un-revealed backlog to show each animation frame. Revealing a
// proportion (rather than a fixed count) means big bursts catch up fast then
// ease out, so the text never lags far behind yet still reads as smooth typing.
const REVEAL_DIVISOR = 5

/**
 * Renders streamed assistant markdown, revealing newly-arrived text at a steady
 * per-frame cadence so bursty SSE chunks read as smooth typing. Settled messages
 * (`animate=false`) render in full immediately.
 */
function StreamingMarkdown({ text, animate }: { text: string; animate: boolean }) {
  const [count, setCount] = useState(animate ? 0 : text.length)
  const countRef = useRef(count)
  countRef.current = count

  useEffect(() => {
    if (!animate) {
      setCount(text.length)
      return
    }
    let raf = 0
    const tick = () => {
      const cur = countRef.current
      if (cur >= text.length) return
      const step = Math.max(1, Math.ceil((text.length - cur) / REVEAL_DIVISOR))
      setCount(cur + step)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [text, animate])

  return <MarkdownRenderer>{animate ? text.slice(0, count) : text}</MarkdownRenderer>
}

/** Bouncing-dots "agent is working" indicator shown before any content lands. */
function StreamingDots({ lead }: { lead?: boolean }) {
  const dot = lead ? "h-2 w-2" : "h-1 w-1"
  const delays = ["0ms", "150ms", "300ms"]
  return (
    <div className={cn("flex items-center", lead ? "gap-1.5 py-1 px-0.5" : "gap-1")}>
      {delays.map((d) => (
        <span
          key={d}
          className={cn(
            "rounded-full bg-primary/60 [animation:chat-typing_1.2s_ease-in-out_infinite]",
            dot
          )}
          style={{ animationDelay: d }}
        />
      ))}
    </div>
  )
}

/**
 * One assistant turn's segments (text and/or tool calls), rendered in order
 * inside a shared bubble body. Kept separate so a single bubble and a grouped
 * run of consecutive turns share identical segment layout.
 */
function AssistantSegments({ messages }: { messages: ChatMessage[] }) {
  const segments = messages.filter(
    (m) => m.content !== "" || m.toolCalls.length > 0
  )
  return (
    <>
      {segments.map((seg, i) => (
        <div key={seg.id} className={i > 0 ? "mt-3" : undefined}>
          {seg.content !== "" && (
            <StreamingMarkdown text={seg.content} animate={Boolean(seg.streaming)} />
          )}
          {seg.toolCalls.length > 0 && (
            <div className={seg.content !== "" ? "mt-3" : undefined}>
              <ChatToolCalls toolCalls={seg.toolCalls} />
            </div>
          )}
        </div>
      ))}
    </>
  )
}

export interface ChatAssistantGroupProps {
  /** Consecutive assistant turns (agent loop steps) shown as one bubble. */
  messages: ChatMessage[]
}

/**
 * A run of consecutive assistant turns rendered under a single avatar and
 * bubble. The agent loop emits one assistant message per step (reason→tool→
 * reason→answer); grouping them presents the whole response as one turn instead
 * of a stack of look-alike bubbles, and mirrors how the run persists (one
 * assistant message) on reload.
 */
export function ChatAssistantGroup({ messages }: ChatAssistantGroupProps) {
  const isStreaming = messages.some((m) => m.streaming)
  const hasBody = messages.some((m) => m.content !== "" || m.toolCalls.length > 0)

  const copyText = messages
    .map((m) => m.content)
    .filter((c) => c !== "")
    .join("\n\n")
  const canCopy = !isStreaming && copyText.trim() !== ""
  const actions = canCopy ? (
    <div className="self-center flex-shrink-0 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      <CopyButton text={copyText} />
    </div>
  ) : null

  return (
    <div className="group flex justify-start gap-3 animate-in fade-in-0 slide-in-from-bottom-1 duration-300">
      <div
        className={cn(
          "h-7 w-7 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 transition-all duration-300",
          isStreaming
            ? "bg-primary/15 ring-2 ring-primary/30 shadow-sm shadow-primary/10"
            : "bg-primary/10"
        )}
      >
        <Bot className="h-3.5 w-3.5 text-primary" />
      </div>
      <div className="min-w-0 max-w-[72%] shadow-sm rounded-2xl rounded-bl-md bg-muted/60 px-4 py-2.5 text-sm text-foreground transition-shadow">
        {isStreaming && !hasBody ? (
          <StreamingDots lead />
        ) : (
          <>
            <AssistantSegments messages={messages} />
            {isStreaming ? (
              <div className="mt-2 border-t border-border/20 pt-1.5">
                <StreamingDots />
              </div>
            ) : (
              <ChatFilesChanged messages={messages} />
            )}
          </>
        )}
      </div>
      {actions}
    </div>
  )
}

export interface ChatMessageBubbleProps {
  message: ChatMessage
  /** Run user-message text through the emoji→icon renderer. */
  renderIcons?: boolean
}

/** Unified user/assistant message bubble. */
export function ChatMessageBubble({ message, renderIcons }: ChatMessageBubbleProps) {
  const isUser = message.role === "user"
  const isStreaming = Boolean(message.streaming)
  const hasToolCalls = message.toolCalls.length > 0
  const hasBody = message.content !== "" || hasToolCalls

  const canCopy = !isStreaming && message.content.trim() !== ""
  const actions = canCopy ? (
    <div className="self-center flex-shrink-0 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      <CopyButton text={message.content} />
    </div>
  ) : null

  return (
    <div
      className={cn(
        "group flex gap-3 animate-in fade-in-0 slide-in-from-bottom-1 duration-300",
        isUser ? "justify-end" : "justify-start"
      )}
    >
      {isUser && actions}
      {!isUser && (
        <div
          className={cn(
            "h-7 w-7 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 transition-all duration-300",
            isStreaming
              ? "bg-primary/15 ring-2 ring-primary/30 shadow-sm shadow-primary/10"
              : "bg-primary/10"
          )}
        >
          <Bot className="h-3.5 w-3.5 text-primary" />
        </div>
      )}
      <div
        className={cn(
          "min-w-0 max-w-[72%] shadow-sm rounded-2xl px-4 py-2.5 text-sm transition-shadow",
          isUser
            ? "bg-primary text-primary-foreground rounded-br-md"
            : "bg-muted/60 text-foreground rounded-bl-md"
        )}
      >
        {!isUser ? (
          isStreaming && !hasBody ? (
            <StreamingDots lead />
          ) : (
            <>
              {message.content !== "" && (
                <StreamingMarkdown text={message.content} animate={isStreaming} />
              )}
              {hasToolCalls && (
                <div className={message.content !== "" ? "mt-3" : undefined}>
                  <ChatToolCalls toolCalls={message.toolCalls} />
                </div>
              )}
              {isStreaming && (
                <div className="mt-2 border-t border-border/20 pt-1.5">
                  <StreamingDots />
                </div>
              )}
            </>
          )
        ) : (
          <p className="whitespace-pre-wrap leading-relaxed break-words">
            {renderIcons ? renderWithIcons(message.content, message.id) : message.content}
          </p>
        )}
      </div>
      {!isUser && actions}
    </div>
  )
}
