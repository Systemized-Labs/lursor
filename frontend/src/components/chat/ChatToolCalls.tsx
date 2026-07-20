import { useEffect, useRef, useState } from "react"
import { Wrench, CaretDown, CaretUp } from "@phosphor-icons/react"

import { cn } from "@/lib/utils"
import type { ChatToolCall } from "@/agui/types"

// Crossfade duration for the ticker; must match the `duration-300` utility on
// the enter/exit layers so the outgoing row is unmounted exactly as its exit
// animation finishes (no post-animation flash).
const TICKER_MS = 300

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
 * Single-slot "ticker" that shows only the most recent tool call. As each new
 * tool arrives it becomes the latest and the previous one is kept mounted just
 * long enough to play its exit — the outgoing row fades up and out while the
 * incoming row fades in from below, so an active turn stays one line tall
 * instead of growing an ever-taller stack (Cursor-style).
 */
export function ToolTicker({
  toolCalls,
  compact,
}: {
  toolCalls: ChatToolCall[]
  compact?: boolean
}) {
  const latest = toolCalls[toolCalls.length - 1]
  // The row currently animating out. We render `latest` directly (no state), so
  // we only need to remember which row it just replaced.
  const [exiting, setExiting] = useState<ChatToolCall | null>(null)
  const shownRef = useRef(latest)

  useEffect(() => {
    if (shownRef.current.id === latest.id) return
    setExiting(shownRef.current)
    shownRef.current = latest
    const t = setTimeout(() => setExiting(null), TICKER_MS)
    return () => clearTimeout(t)
  }, [latest.id, latest])

  return (
    <div className="relative min-w-0">
      {exiting && exiting.id !== latest.id && (
        <div
          key={exiting.id}
          className="pointer-events-none absolute inset-x-0 top-0 animate-out fade-out-0 slide-out-to-top-2 fill-mode-forwards duration-300"
        >
          <ToolCallRow toolCall={exiting} compact={compact} />
        </div>
      )}
      <div
        key={latest.id}
        className="animate-in fade-in-0 slide-in-from-bottom-2 duration-300"
      >
        <ToolCallRow toolCall={latest} compact={compact} />
      </div>
    </div>
  )
}

/**
 * Transcript of the tools an agent invoked during a turn. Collapsed by default
 * to a single-slot {@link ToolTicker} showing the latest tool, with a "+N
 * earlier" affordance to reveal the full stack — keeping a busy turn condensed.
 * Each row can still be expanded to reveal its result.
 */
export function ChatToolCalls({
  toolCalls,
  compact,
}: {
  toolCalls: ChatToolCall[]
  compact?: boolean
}) {
  const [expanded, setExpanded] = useState(false)

  if (!toolCalls.length) return null

  const affordanceClass =
    "flex items-center gap-1 text-[11px] text-muted-foreground/70 transition-colors hover:text-foreground"

  if (toolCalls.length === 1) {
    return (
      <div className="space-y-1.5">
        <ToolCallRow toolCall={toolCalls[0]} compact={compact} />
      </div>
    )
  }

  if (expanded) {
    return (
      <div className="space-y-1.5">
        {/* Collapse control stays at the top so it's always reachable even when
            the list is long enough to scroll. */}
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className={affordanceClass}
        >
          <CaretUp className="h-3 w-3 shrink-0" />
          Show less
        </button>
        {/* Cap the height and scroll internally so expanding never pushes the
            list past the viewport where overflow-hidden ancestors clip it. */}
        <div className="max-h-72 space-y-1.5 overflow-y-auto">
          {toolCalls.map((tc) => (
            <ToolCallRow key={tc.id} toolCall={tc} compact={compact} />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <ToolTicker toolCalls={toolCalls} compact={compact} />
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className={affordanceClass}
      >
        <CaretDown className="h-3 w-3 shrink-0" />
        {toolCalls.length - 1} earlier
      </button>
    </div>
  )
}
