import { cn } from "@/lib/utils"

/** Bouncing-dots "agent is working" indicator. One consistent size everywhere it
 *  appears (pending, pre-content, trailing mid-stream) so it never resizes as a
 *  turn progresses; `lead` adds standalone padding when it isn't hugging content. */
export function StreamingDots({ lead }: { lead?: boolean }) {
  const delays = ["0ms", "150ms", "300ms"]
  return (
    <div className={cn("flex items-center gap-1", lead && "py-1")}>
      {delays.map((d) => (
        <span
          key={d}
          className="h-1 w-1 rounded-full bg-primary/60 [animation:chat-typing_1.2s_ease-in-out_infinite]"
          style={{ animationDelay: d }}
        />
      ))}
    </div>
  )
}

/** The "agent is working" loader shown the instant a turn is sent, before any
 *  assistant event arrives, so the conversation never looks stuck in the gap
 *  between send and the first token. */
export function ChatPendingReply() {
  return (
    <div className="group animate-in fade-in-0 slide-in-from-bottom-1 duration-300">
      <StreamingDots lead />
    </div>
  )
}
