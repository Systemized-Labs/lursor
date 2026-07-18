import { useState } from "react"
import { Brain, CaretDown } from "@phosphor-icons/react"

import { cn } from "@/lib/utils"
import { MarkdownRenderer } from "@/components/ui/markdown-renderer"

/**
 * A turn's streamed reasoning ("thinking") tokens.
 *
 * This is the model's raw chain-of-thought — internal scaffolding, NOT the
 * answer. It's verbose, can contain dead-ends/errors, and may not reflect the
 * final response, so we treat it as a secondary, opt-in disclosure rather than
 * primary content: collapsed by default, visually set apart, expanded only on
 * click. While it streams we show a "Thinking…" indicator instead of dumping the
 * incomplete tokens. There is deliberately no auto-expand/auto-collapse cycle —
 * that transition is what caused the earlier UI flash.
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
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <Brain className="h-3.5 w-3.5 shrink-0" />
        <span className={cn("shrink-0", streaming && "animate-pulse")}>
          {streaming ? "Thinking…" : "Thoughts"}
        </span>
        <CaretDown
          className={cn(
            "ml-auto h-3 w-3 shrink-0 transition-transform",
            open && "rotate-180"
          )}
        />
      </button>

      {open && (
        <div className="mt-1 max-h-72 overflow-auto border-l-2 border-border/60 pl-3 text-[13px] text-muted-foreground [&_*]:text-muted-foreground">
          <MarkdownRenderer>{reasoning}</MarkdownRenderer>
        </div>
      )}
    </div>
  )
}
