import { useState } from "react"
import { Wrench, CaretDown } from "@phosphor-icons/react"

import { cn } from "@/lib/utils"
import type { ChatToolCall } from "@/agui/types"

/** Compact one-line preview of a tool call's arguments. */
export function argsPreview(args: unknown): string {
  if (args == null) return ""
  let obj: unknown = args
  if (typeof args === "string") {
    if (!args.trim()) return ""
    try {
      obj = JSON.parse(args)
    } catch {
      return args.length > 80 ? `${args.slice(0, 80)}…` : args
    }
  }
  if (obj && typeof obj === "object") {
    const parts = Object.entries(obj as Record<string, unknown>).map(([k, v]) => {
      const val = typeof v === "string" ? v : JSON.stringify(v)
      return `${k}: ${val}`
    })
    const joined = parts.join(", ")
    return joined.length > 90 ? `${joined.slice(0, 90)}…` : joined
  }
  const s = String(obj)
  return s.length > 90 ? `${s.slice(0, 90)}…` : s
}

/** A single tool call: name + argument preview, expandable to reveal its result. */
function ToolCallRow({
  toolCall,
  compact,
}: {
  toolCall: ChatToolCall
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const preview = argsPreview(toolCall.args)
  const hasResult = toolCall.result !== undefined && toolCall.result !== ""

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={!hasResult}
        className="flex w-full min-w-0 items-baseline gap-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground disabled:hover:text-muted-foreground"
      >
        <Wrench
          className={cn(
            "shrink-0 self-center",
            compact ? "h-3 w-3" : "h-3.5 w-3.5"
          )}
        />
        <span className="shrink-0 font-mono text-foreground">{toolCall.name}</span>
        {preview && (
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {preview}
          </span>
        )}
        {hasResult && (
          <CaretDown
            className={cn(
              "ml-auto h-3 w-3 shrink-0 self-center transition-transform",
              open && "rotate-180"
            )}
          />
        )}
      </button>

      {open && hasResult && (
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground">
          {toolCall.result}
        </pre>
      )}
    </div>
  )
}

/**
 * Transcript of the tools an agent invoked during a turn. Each tool renders as
 * its own row showing the tool's name and an argument preview; a row with a
 * result can be expanded to reveal it.
 */
export function ChatToolCalls({
  toolCalls,
  compact,
}: {
  toolCalls: ChatToolCall[]
  compact?: boolean
}) {
  if (!toolCalls.length) return null

  return (
    <div className="space-y-1.5">
      {toolCalls.map((tc) => (
        <ToolCallRow key={tc.id} toolCall={tc} compact={compact} />
      ))}
    </div>
  )
}
