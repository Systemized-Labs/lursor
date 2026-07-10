import { type RefObject, type ReactNode } from "react"
import { ArrowDown } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { ChatMessageBubble } from "@/components/chat/ChatMessageBubble"
import type { ChatMessage } from "@/agui/types"

/** Shimmer placeholder shown while a conversation's history loads. */
function ChatSkeleton() {
  const rows: { role: "assistant" | "user"; widths: string[] }[] = [
    { role: "assistant", widths: ["w-3/4", "w-1/2"] },
    { role: "user", widths: ["w-2/5"] },
    { role: "assistant", widths: ["w-5/6", "w-2/3", "w-1/3"] },
    { role: "user", widths: ["w-1/3"] },
  ]
  return (
    <div className="space-y-5" aria-hidden>
      {rows.map((row, i) => (
        <div
          key={i}
          className={cn("flex gap-3", row.role === "user" ? "justify-end" : "justify-start")}
        >
          {row.role === "assistant" && (
            <Skeleton className="h-7 w-7 rounded-full flex-shrink-0" />
          )}
          <div
            className={cn(
              "flex max-w-[72%] flex-col gap-1.5 rounded-2xl px-4 py-3",
              row.role === "user" ? "bg-primary/10 items-end" : "bg-muted/50"
            )}
          >
            {row.widths.map((w, j) => (
              <Skeleton key={j} className={cn("h-3.5", w, "min-w-24")} />
            ))}
          </div>
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
        messages.map((message) => (
          <ChatMessageBubble
            key={message.id}
            message={message}
            renderIcons={renderIcons}
          />
        ))
      )}
      {onScrollToBottom && showScrollToBottom && (
        <div className="sticky bottom-0 z-10 h-0">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={onScrollToBottom}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 gap-1.5 whitespace-nowrap rounded-full border border-border shadow-md animate-in fade-in-0 slide-in-from-bottom-2"
          >
            <ArrowDown className="h-3.5 w-3.5" />
            Jump to latest
          </Button>
        </div>
      )}
      <div ref={endRef} />
    </div>
  )
}
