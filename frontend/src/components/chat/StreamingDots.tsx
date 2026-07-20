import { cn } from "@/lib/utils"

/** Bouncing-dots "agent is working" indicator. One consistent size everywhere it
 *  appears (pending, pre-content, trailing mid-stream) so it never resizes as a
 *  turn progresses; `lead` adds standalone padding when it isn't hugging content. */
export function StreamingDots({ lead }: { lead?: boolean }) {
  const delays = ["0ms", "150ms", "300ms"]
  return (
    <div className={cn("flex items-center gap-1.5", lead && "py-1")}>
      {delays.map((d) => (
        <span
          key={d}
          className="h-2 w-2 rounded-full bg-primary/60 [animation:chat-typing_1.2s_ease-in-out_infinite]"
          style={{ animationDelay: d }}
        />
      ))}
    </div>
  )
}
