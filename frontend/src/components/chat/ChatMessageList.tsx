import { type RefObject, type ReactNode } from "react"
import { ArrowDown } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import {
  ChatAssistantGroup,
  ChatMessageBubble,
} from "@/components/chat/ChatMessageBubble"
import type { ChatMessage } from "@/agui/types"

type Segment =
  | { kind: "message"; message: ChatMessage }
  | { kind: "assistant-group"; id: string; messages: ChatMessage[] }

/**
 * Collapses runs of consecutive assistant turns into one group so the agent
 * loop's steps render as a single block. Everything else passes through as its
 * own message.
 */
function groupMessages(messages: ChatMessage[]): Segment[] {
  const segments: Segment[] = []
  for (const message of messages) {
    const last = segments[segments.length - 1]
    if (message.role === "assistant") {
      if (last?.kind === "assistant-group") {
        last.messages.push(message)
      } else {
        segments.push({ kind: "assistant-group", id: message.id, messages: [message] })
      }
    } else {
      segments.push({ kind: "message", message })
    }
  }
  return segments
}

/** A conversational exchange: a user prompt and the assistant reply it drew. */
interface Turn {
  id: string
  user?: Extract<Segment, { kind: "message" }>
  assistant?: Extract<Segment, { kind: "assistant-group" }>
}

/**
 * Pairs each user prompt with the assistant reply that follows it into a "turn".
 * Rendering turns (rather than a flat segment list) lets the reply hug its
 * prompt while turns sit far apart — the exchange-based rhythm that reads as a
 * conversation instead of an undifferentiated stream.
 */
function groupTurns(segments: Segment[]): Turn[] {
  const turns: Turn[] = []
  for (const seg of segments) {
    const last = turns[turns.length - 1]
    if (seg.kind === "message") {
      turns.push({ id: seg.message.id, user: seg })
    } else if (last && last.assistant === undefined) {
      last.assistant = seg
    } else {
      turns.push({ id: seg.id, assistant: seg })
    }
  }
  return turns
}

/** Shimmer placeholder shown while a conversation's history loads. Mirrors the
 *  document layout: assistant turns are plain text lines, user turns a card. */
function ChatSkeleton() {
  const rows: { role: "assistant" | "user"; widths: string[] }[] = [
    { role: "assistant", widths: ["w-3/4", "w-1/2"] },
    { role: "user", widths: ["w-2/5"] },
    { role: "assistant", widths: ["w-5/6", "w-2/3", "w-1/3"] },
    { role: "user", widths: ["w-1/3"] },
  ]
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6" aria-hidden>
      {rows.map((row, i) => (
        <div
          key={i}
          className={cn(
            "flex flex-col gap-2",
            row.role === "user" && "rounded-xl bg-muted/40 px-4 py-3"
          )}
        >
          {row.widths.map((w, j) => (
            <Skeleton key={j} className={cn("h-3.5", w, "min-w-24")} />
          ))}
        </div>
      ))}
    </div>
  )
}

export interface ChatMessageListProps {
  messages: ChatMessage[]
  /** Sentinel at the bottom of the list used for auto-scroll. */
  endRef: RefObject<HTMLDivElement>
  /** Scroll container ref. */
  containerRef?: RefObject<HTMLDivElement>
  /** Applied to the list root (scroll + vertical spacing). */
  className?: string
  isLoadingMessages?: boolean
  /** Rendered in place of the timeline when there are no messages. */
  empty?: ReactNode
  renderIcons?: boolean
  /** Show the floating "jump to latest" button (user has scrolled away). */
  showScrollToBottom?: boolean
  /** Re-pin to the bottom and resume auto-scroll. */
  onScrollToBottom?: () => void
}

/** Scrollable message timeline: maps messages to bubbles with loading / empty
 *  states and a floating "jump to latest" affordance. */
export function ChatMessageList({
  messages,
  endRef,
  containerRef,
  className,
  isLoadingMessages,
  empty,
  renderIcons,
  showScrollToBottom,
  onScrollToBottom,
}: ChatMessageListProps) {
  return (
    <div ref={containerRef} className={className}>
      {isLoadingMessages ? (
        <ChatSkeleton />
      ) : messages.length === 0 ? (
        empty
      ) : (
        <>
          <div className="mx-auto w-full max-w-3xl space-y-10">
            {groupTurns(groupMessages(messages)).map((turn) => (
              <div key={turn.id} className="space-y-4">
                {turn.user && (
                  <ChatMessageBubble
                    message={turn.user.message}
                    renderIcons={renderIcons}
                  />
                )}
                {turn.assistant && (
                  <ChatAssistantGroup messages={turn.assistant.messages} />
                )}
              </div>
            ))}
          </div>
          {onScrollToBottom && showScrollToBottom && (
            <div className="sticky bottom-0 z-10 h-0">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={onScrollToBottom}
                className="absolute bottom-4 left-1/2 -translate-x-1/2 gap-1.5 whitespace-nowrap rounded-full border-0 shadow-md animate-in fade-in-0 slide-in-from-bottom-2"
              >
                <ArrowDown className="h-3.5 w-3.5" />
                Jump to latest
              </Button>
            </div>
          )}
          <div ref={endRef} />
        </>
      )}
    </div>
  )
}
