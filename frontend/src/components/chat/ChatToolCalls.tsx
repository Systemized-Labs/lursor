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

/**
 * Collapsible transcript of the tools an agent invoked during a turn. The
 * header shows the count; expanding reveals each tool's name, argument preview,
 * and (when present) its result.
 */
export function ChatToolCalls({
  toolCalls,
  compact,
}: {
  toolCalls: ChatToolCall[]
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  if (!toolCalls.length) return null

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <Wrench className={cn(compact ? "h-3 w-3" : "h-3.5 w-3.5")} />
        <span>
          {toolCalls.length} tool{toolCalls.length === 1 ? "" : "s"} used
        </span>
        <CaretDown
          className={cn("h-3 w-3 transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <div className="mt-1.5 space-y-2">
          {toolCalls.map((tc) => {
            const preview = argsPreview(tc.args)
            return (
              <div key={tc.id} className="min-w-0">
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className="font-mono text-xs text-foreground shrink-0">
                    {tc.name}
                  </span>
                  {preview && (
                    <span className="truncate font-mono text-[11px] text-muted-foreground">
                      {preview}
                    </span>
                  )}
                </div>
                {tc.result !== undefined && tc.result !== "" && (
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/40 p-2 font-mono text-[11px] text-muted-foreground">
                    {tc.result}
                  </pre>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
