import { useEffect, useRef, useState } from "react"
import { Copy, Check } from "@phosphor-icons/react"

import { cn, copyToClipboard } from "@/lib/utils"
import { renderWithIcons } from "@/lib/emoji-icons"
import { MarkdownRenderer } from "@/components/ui/markdown-renderer"
import { ChatToolCalls } from "@/components/chat/ChatToolCalls"
import {
  ChatSubagentCalls,
  SUBAGENT_TOOL_NAME,
} from "@/components/chat/ChatSubagentCalls"
import { ChatFilesChanged } from "@/components/chat/ChatFilesChanged"
import type { ChatMessage } from "@/agui/types"

/** Hover action button that copies a message's text to the clipboard. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        copyToClipboard(text).then((ok) => {
          if (!ok) return
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      title={copied ? "Copied" : "Copy"}
      aria-label="Copy message"
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
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
    <div className={cn("flex items-center", lead ? "gap-1.5 py-1" : "gap-1")}>
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
 * One assistant turn's segments (text and/or tool calls), rendered in order as a
 * flowing document — no bubble, no avatar. Kept separate so a single message and
 * a grouped run of consecutive turns share identical segment layout.
 */
function AssistantSegments({ messages }: { messages: ChatMessage[] }) {
  const segments = messages.filter(
    (m) => m.content !== "" || m.toolCalls.length > 0
  )
  return (
    <>
      {segments.map((seg, i) => {
        // Subagent delegations (`task`) get their own cards; the rest stay in
        // the collapsed tool transcript.
        const subagentCalls = seg.toolCalls.filter(
          (t) => t.name === SUBAGENT_TOOL_NAME
        )
        const otherCalls = seg.toolCalls.filter(
          (t) => t.name !== SUBAGENT_TOOL_NAME
        )
        return (
          <div key={seg.id} className={i > 0 ? "mt-3" : undefined}>
            {seg.content !== "" && (
              <StreamingMarkdown text={seg.content} animate={Boolean(seg.streaming)} />
            )}
            {subagentCalls.length > 0 && (
              <div className={seg.content !== "" ? "mt-3" : undefined}>
                <ChatSubagentCalls calls={subagentCalls} />
              </div>
            )}
            {otherCalls.length > 0 && (
              <div className={seg.content !== "" || subagentCalls.length > 0 ? "mt-3" : undefined}>
                <ChatToolCalls toolCalls={otherCalls} />
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}

export interface ChatAssistantGroupProps {
  /** Consecutive assistant turns (agent loop steps) shown as one document block. */
  messages: ChatMessage[]
}

/**
 * A run of consecutive assistant turns rendered as one flowing document block.
 * The agent loop emits one assistant message per step (reason→tool→reason→
 * answer); grouping them presents the whole response as a single turn instead of
 * a stack of look-alike blocks, and mirrors how the run persists (one assistant
 * message) on reload. No bubble/avatar — the transcript reads like a document.
 */
export function ChatAssistantGroup({ messages }: ChatAssistantGroupProps) {
  const isStreaming = messages.some((m) => m.streaming)
  const hasBody = messages.some((m) => m.content !== "" || m.toolCalls.length > 0)

  const copyText = messages
    .map((m) => m.content)
    .filter((c) => c !== "")
    .join("\n\n")
  const canCopy = !isStreaming && copyText.trim() !== ""

  return (
    <div className="group animate-in fade-in-0 slide-in-from-bottom-1 duration-300">
      {isStreaming && !hasBody ? (
        <StreamingDots lead />
      ) : (
        <div className="min-w-0 text-sm text-foreground">
          <AssistantSegments messages={messages} />
          {isStreaming ? (
            <div className="mt-2">
              <StreamingDots />
            </div>
          ) : (
            <>
              <ChatFilesChanged messages={messages} />
              {canCopy && (
                <div className="-ml-1.5 mt-1.5 flex items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                  <CopyButton text={copyText} />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

export interface ChatMessageBubbleProps {
  message: ChatMessage
  /** Run user-message text through the emoji→icon renderer. */
  renderIcons?: boolean
}

/**
 * A single message. Assistant messages render as a document block (delegating to
 * {@link ChatAssistantGroup}); user messages render as a subtle, unshadowed card
 * so the prompt is distinguishable without breaking the document flow.
 */
export function ChatMessageBubble({ message, renderIcons }: ChatMessageBubbleProps) {
  if (message.role !== "user") {
    return <ChatAssistantGroup messages={[message]} />
  }

  const hasAttachments = message.attachments && message.attachments.length > 0

  return (
    <div className="group animate-in fade-in-0 slide-in-from-bottom-1 duration-300">
      <div className="rounded-xl border border-border/60 bg-muted/25 px-4 py-2.5 text-[0.9375rem] leading-relaxed text-foreground">
        {hasAttachments && (
          <div
            className={cn(
              "flex flex-wrap gap-2",
              message.content !== "" && "mb-2"
            )}
          >
            {message.attachments!.map((att, i) => (
              <a
                key={`${att.url}-${i}`}
                href={att.url}
                target="_blank"
                rel="noreferrer"
                title={att.name}
                className="block overflow-hidden rounded-lg border border-border/60"
              >
                <img
                  src={att.url}
                  alt={att.name ?? "attachment"}
                  className="max-h-48 max-w-[16rem] object-cover"
                />
              </a>
            ))}
          </div>
        )}
        {message.content !== "" && (
          <p className="whitespace-pre-wrap leading-relaxed break-words">
            {renderIcons
              ? renderWithIcons(message.content, message.id)
              : message.content}
          </p>
        )}
      </div>
    </div>
  )
}
