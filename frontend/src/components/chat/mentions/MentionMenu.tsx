import { useEffect, useRef } from "react"
import { CaretRight, ArrowElbowDownLeft } from "@phosphor-icons/react"

import { cn } from "@/lib/utils"
import type { MentionSource } from "./types"
import type { MenuRow } from "./use-mentions"

export interface MentionMenuProps {
  open: boolean
  rows: MenuRow[]
  mode: "root" | "category"
  category: MentionSource | null
  loading: boolean
  activeIndex: number
  onHover: (index: number) => void
  onSelect: (row: MenuRow) => void
  compact?: boolean
}

/** Typeahead popover for `@` mentions, anchored above the composer. */
export function MentionMenu({
  open,
  rows,
  mode,
  category,
  loading,
  activeIndex,
  onHover,
  onSelect,
  compact,
}: MentionMenuProps) {
  const activeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" })
  }, [activeIndex, rows.length])

  if (!open) return null

  return (
    <div
      className="absolute bottom-full left-0 right-0 mb-2 z-50 overflow-hidden rounded-lg border border-border/60 bg-popover text-popover-foreground shadow-lg"
      // Keep textarea focus when interacting with the menu.
      onMouseDown={(e) => e.preventDefault()}
    >
      {mode === "category" && category && (
        <div className="flex items-center gap-1.5 border-b border-border/60 bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
          <category.icon className="h-3.5 w-3.5" />
          <span className="font-medium text-foreground">{category.label}</span>
        </div>
      )}
      <div className={cn("max-h-64 overflow-y-auto py-1", compact && "max-h-52")}>
        {rows.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            {loading ? "Searching…" : "No matches"}
          </p>
        ) : (
          rows.map((row, i) => {
            const isActive = i === activeIndex
            const isCategoryRow = row.kind === "category"
            const Icon = (row.kind === "item" && row.item.icon) || row.source.icon
            const label = row.kind === "category" ? row.source.label : row.item.label
            const sublabel =
              row.kind === "category"
                ? "Browse"
                : row.item.sublabel ?? (mode === "root" ? row.source.label : undefined)
            const drillable =
              row.kind === "category" || (row.kind === "item" && row.item.container)
            return (
              <button
                key={`${row.kind}-${
                  row.kind === "category"
                    ? row.source.key
                    : `${row.source.key}/${row.item.id}`
                }`}
                ref={isActive ? activeRef : undefined}
                type="button"
                onMouseEnter={() => onHover(i)}
                onClick={() => onSelect(row)}
                className={cn(
                  "flex w-full items-center gap-2 px-2.5 text-left",
                  compact ? "py-1 text-xs" : "py-1.5 text-sm",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground hover:bg-muted"
                )}
              >
                <Icon className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="flex-1 truncate">{label}</span>
                {sublabel && (
                  <span
                    className={cn(
                      "max-w-[40%] truncate text-xs",
                      !isCategoryRow && "text-muted-foreground"
                    )}
                  >
                    {sublabel}
                  </span>
                )}
                {drillable ? (
                  <CaretRight className="h-3.5 w-3.5 flex-shrink-0" />
                ) : isActive ? (
                  <ArrowElbowDownLeft className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
                ) : null}
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
