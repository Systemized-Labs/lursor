import { useShallow } from "zustand/react/shallow"

import { useChatSelector } from "@/agui/chatStore"
import type { ChatMessage } from "@/agui/types"

import { SUBAGENT_TOOL_NAME } from "./ChatSubagentCalls"
import { ChatToolCalls } from "./ChatToolCalls"
import { StreamingDots } from "./StreamingDots"

/**
 * The live-activity cluster shown just above the composer while the agent works:
 * the running turn's latest tool call in a single-slot ticker (same fade/slide
 * animation the inline ticker used), expandable to the full list of tools called
 * so far, sitting directly above the "working" dots.
 * Pulling both out of the transcript keeps the chat text clean, and the cluster
 * unmounts once the run settles — settled messages drop their `streaming` flag,
 * so the tool selection empties and `isStreaming` goes false. Subagent (Task)
 * calls stay inline and are excluded here.
 */
export function ChatLiveActivity() {
  const isStreaming = useChatSelector((s) => s.isStreaming)
  const calls = useChatSelector(
    useShallow((s) =>
      s.order
        .map((id) => s.byId[id])
        .filter((m): m is ChatMessage => Boolean(m?.streaming))
        .flatMap((m) => m.toolCalls)
        .filter((t) => t.name !== SUBAGENT_TOOL_NAME)
    )
  )

  if (!isStreaming && calls.length === 0) return null

  const hasTools = calls.length > 0

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-8 sm:px-6">
      {hasTools ? (
        // Tools called this turn (latest in the ticker, expandable to the full
        // list) with the working dots as a divided footer — one cohesive card.
        <div className="animate-in fade-in-0 slide-in-from-bottom-1 overflow-hidden rounded-xl border border-border/60 bg-muted/30 px-3.5 py-3 duration-200">
          <ChatToolCalls toolCalls={calls} />
          {isStreaming && (
            <div className="mt-2.5 border-t border-border/40 pt-2.5">
              <StreamingDots />
            </div>
          )}
        </div>
      ) : (
        // No tools yet — just the lightweight working indicator, no heavy card.
        isStreaming && (
          <div className="px-1.5">
            <StreamingDots />
          </div>
        )
      )}
    </div>
  )
}
