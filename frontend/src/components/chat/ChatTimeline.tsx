import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ArrowDown, CaretUp } from "@phosphor-icons/react"
import { useStore } from "zustand"
import {
  StickToBottom,
  type StickToBottomContext,
  type StickToBottomInstance,
} from "use-stick-to-bottom"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { useChatStoreApi } from "@/agui/chatStore"
import type { ChatRole } from "@/agui/types"

import { MessageRow } from "./MessageRow"
import { AssistantGroup } from "./AssistantGroup"
import { ChatPendingReply } from "./StreamingDots"

/** A conversational exchange: a user prompt and the assistant reply it drew. */
interface Turn {
  id: string
  userId?: string
  assistantIds?: string[]
}

/**
 * Groups an ordered id list into turns: runs of consecutive assistant messages
 * (agent loop steps) collapse into one reply block, each paired with the user
 * prompt before it. Recomputed only when `order`/window changes — never on tokens
 * (roles are immutable), so streaming never rebuilds this.
 */
function buildTurns(ids: string[], roleOf: (id: string) => ChatRole | undefined): Turn[] {
  type Seg = { kind: "msg"; id: string } | { kind: "group"; id: string; ids: string[] }
  const segs: Seg[] = []
  for (const id of ids) {
    const last = segs[segs.length - 1]
    if (roleOf(id) === "assistant") {
      if (last?.kind === "group") last.ids.push(id)
      else segs.push({ kind: "group", id, ids: [id] })
    } else {
      segs.push({ kind: "msg", id })
    }
  }
  const turns: Turn[] = []
  for (const seg of segs) {
    const last = turns[turns.length - 1]
    if (seg.kind === "msg") turns.push({ id: seg.id, userId: seg.id })
    else if (last && last.assistantIds === undefined) last.assistantIds = seg.ids
    else turns.push({ id: seg.id, assistantIds: seg.ids })
  }
  return turns
}

/** Shimmer placeholder shown while a conversation's history loads. */
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

/** How many messages render initially, and how many more each "show older" click
 *  reveals — keeps the DOM small for very long conversations. */
const DEFAULT_WINDOW_SIZE = 10

export interface ChatTimelineProps {
  isLoadingMessages?: boolean
  /** Changing this (the thread id) resets the window to the tail. */
  resetKey?: string
  /** Rendered when there are no messages. */
  empty?: ReactNode
  windowSize?: number
  /** Scroll instance owned by the page, so it can re-pin to the bottom on send
   *  (via `instance.scrollToBottom()`). */
  instance?: StickToBottomInstance
}

/**
 * The message timeline. Subscribes only to `order` (structure) and a couple of
 * derived booleans — a streamed token mutates one message slice, re-rendering
 * that row alone, never this list. Auto-scroll is delegated to use-stick-to-bottom
 * (streaming-aware, pins before paint).
 */
export function ChatTimeline({
  isLoadingMessages,
  resetKey,
  empty,
  windowSize = DEFAULT_WINDOW_SIZE,
  instance,
}: ChatTimelineProps) {
  const store = useChatStoreApi()
  const order = useStore(store, (s) => s.order)
  const isStreaming = useStore(store, (s) => s.isStreaming)
  // Streaming has begun but the assistant hasn't emitted its first event: the
  // last message is still the user's prompt. Show a working loader hugging it.
  const awaitingReply = useStore(store, (s) => {
    if (!s.isStreaming) return false
    return s.byId[s.order[s.order.length - 1]]?.role === "user"
  })

  const [visibleCount, setVisibleCount] = useState(windowSize)
  useEffect(() => setVisibleCount(windowSize), [resetKey, windowSize])

  const hasOlder = order.length > visibleCount
  const turns = useMemo(() => {
    const ids = hasOlder ? order.slice(-visibleCount) : order
    return buildTurns(ids, (id) => store.getState().byId[id]?.role)
  }, [order, visibleCount, hasOlder, store])

  // Revealing older messages prepends above the viewport. Capture the scroll
  // offset before the extra turns mount and restore it after, so the message the
  // user is reading stays put (the browser's overflow-anchor is off).
  const ctxRef = useRef<StickToBottomContext | null>(null)
  const pendingScrollRef = useRef<{ height: number; top: number } | null>(null)
  function showOlder() {
    const el = ctxRef.current?.scrollRef.current
    if (el) pendingScrollRef.current = { height: el.scrollHeight, top: el.scrollTop }
    setVisibleCount((n) => n + windowSize)
  }
  useLayoutEffect(() => {
    const el = ctxRef.current?.scrollRef.current
    const pending = pendingScrollRef.current
    if (!el || !pending) return
    pendingScrollRef.current = null
    el.scrollTop = pending.top + (el.scrollHeight - pending.height)
  }, [visibleCount])

  if (isLoadingMessages) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <ChatSkeleton />
      </div>
    )
  }
  if (order.length === 0) {
    return <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">{empty}</div>
  }

  return (
    <StickToBottom
      instance={instance}
      contextRef={ctxRef}
      className="relative min-h-0 flex-1 overflow-hidden"
      resize="smooth"
      initial="instant"
    >
      {({ isAtBottom, scrollToBottom }: StickToBottomContext) => (
        <>
          <StickToBottom.Content
            className="mx-auto w-full max-w-3xl space-y-10 px-4 py-5 sm:px-6"
            scrollClassName="[overflow-anchor:none]"
          >
            {hasOlder && (
              <div className="flex justify-center">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={showOlder}
                  className="gap-1.5 text-muted-foreground"
                >
                  <CaretUp className="h-3.5 w-3.5" />
                  Show older messages
                </Button>
              </div>
            )}
            {turns.map((turn, i) => (
              <div key={turn.id} className="space-y-4">
                {turn.userId && <MessageRow id={turn.userId} />}
                {turn.assistantIds ? (
                  <AssistantGroup ids={turn.assistantIds} />
                ) : (
                  awaitingReply && i === turns.length - 1 && <ChatPendingReply />
                )}
              </div>
            ))}
          </StickToBottom.Content>

          {!isAtBottom && (
            <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => void scrollToBottom()}
                className="pointer-events-auto gap-1.5 whitespace-nowrap rounded-full border-0 shadow-md animate-in fade-in-0 slide-in-from-bottom-2"
              >
                <ArrowDown className="h-3.5 w-3.5" />
                {isStreaming ? "New messages" : "Jump to latest"}
              </Button>
            </div>
          )}
        </>
      )}
    </StickToBottom>
  )
}
