import { useEffect, useRef } from "react"
import { ArrowElbowDownLeft } from "@phosphor-icons/react"

import { cn } from "@/lib/utils"
import type { SlashCommand } from "./types"

export interface SlashMenuProps {
  open: boolean
  rows: SlashCommand[]
  activeIndex: number
  onHover: (index: number) => void
  onSelect: (command: SlashCommand) => void
}

/** Typeahead popover for `/` slash commands, anchored above the composer.
 *  Mirrors `MentionMenu`; driven entirely by the command registry. */
export function SlashMenu({
  open,
  rows,
  activeIndex,
  onHover,
  onSelect,
}: SlashMenuProps) {
  const activeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" })
  }, [activeIndex, rows.length])

  if (!open) return null

  return (
    <div
      className="absolute bottom-full left-0 right-0 z-50 mb-2 overflow-hidden rounded-lg border border-border/60 bg-popover text-popover-foreground shadow-lg"
      // Keep textarea focus when interacting with the menu.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="max-h-64 overflow-y-auto py-1">
        {rows.map((cmd, i) => {
          const isActive = i === activeIndex
          const Icon = cmd.Icon
          return (
            <button
              key={cmd.name}
              ref={isActive ? activeRef : undefined}
              type="button"
              onMouseEnter={() => onHover(i)}
              onClick={() => onSelect(cmd)}
              className={cn(
                "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm",
                isActive
                  ? "bg-accent text-accent-foreground"
                  : "text-foreground hover:bg-muted"
              )}
            >
              <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
              <span className="flex-shrink-0 font-medium">/{cmd.name}</span>
              {cmd.argumentHint && (
                <span className="flex-shrink-0 text-xs text-muted-foreground">
                  {cmd.argumentHint}
                </span>
              )}
              <span className="ml-auto truncate pl-2 text-xs text-muted-foreground">
                {cmd.description}
              </span>
              {isActive && (
                <ArrowElbowDownLeft className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
