import { useState } from "react"
import { Brain, CaretDown } from "@phosphor-icons/react"

import { cn } from "@/lib/utils"
import { MarkdownRenderer } from "@/components/ui/markdown-renderer"

/**
 * A turn's streamed reasoning ("thinking") tokens, shown as a collapsible block.
 * Reasoning models can emit a long thinking phase before any answer or tool call;
 * without this the transcript looks blank while the model works. Kept collapsed
 * by default (the user can expand it) — auto-expanding while streaming and then
 * snapping shut caused a UI flash.
 */
export function ChatReasoning({
  reasoning,
  streaming,
}: {
  reasoning: string
  streaming?: boolean
}) {
  const [open, setOpen] = useState(false)

  if (!reasoning) return null

  return (
    <div className="min-w-0">
      <button
        type="button"
        data-testid="chat-reasoning"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full min-w-0 items-center gap-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <Brain className="h-3.5 w-3.5 shrink-0" />
        <span className="shrink-0">{streaming ? "Thinking…" : "Reasoning"}</span>
        <CaretDown
          className={cn(
            "ml-auto h-3 w-3 shrink-0 transition-transform",
            open && "rotate-180"
          )}
        />
      </button>

      {open && (
        <div className="mt-1 max-h-72 overflow-auto rounded-md border border-border/60 bg-muted/40 p-2 text-[13px] text-muted-foreground [&_*]:text-muted-foreground">
          <MarkdownRenderer>{reasoning}</MarkdownRenderer>
        </div>
      )}
    </div>
  )
}
