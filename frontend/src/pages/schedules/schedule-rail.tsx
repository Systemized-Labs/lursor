import { MagnifyingGlass, WarningCircle } from "@phosphor-icons/react"
import { useCallback, useEffect, useRef } from "react"

import type { Schedule } from "@/api/types"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import {
  FIRE_STATUS_DOT,
  fireSummary,
  isFireProblem,
  relativeTime,
  runTypeSummary,
} from "./schedule-format"

/** How a selection was made — an auto-selection must not act like a click. */
export type SelectSource = "pointer" | "keyboard" | "auto"

interface ScheduleRailProps {
  /** Schedules matching the current search, in display order. */
  schedules: Schedule[]
  /** Size of the whole set, so the header can say "n of m". */
  total: number
  workspaceNames: Map<string, string>
  agentNames: Map<string, string>
  /** Thread ids with a live run, so a firing schedule reads as working. */
  runningThreadIds: Set<string>
  search: string
  onSearchChange: (value: string) => void
  selectedId: string | undefined
  onSelect: (schedule: Schedule | undefined, source: SelectSource) => void
  /** Enter or a double click: jump the detail pane's name field into edit. */
  onActivate: (schedule: Schedule) => void
}

/**
 * The dense half of the Schedules browser: one line per schedule, answering "what
 * fires next, and did the last one go wrong?" without opening anything.
 *
 * A row carries no controls — not even the enabled toggle. Everything you can *do*
 * lives in the detail pane, which has the room to say what a control means; a
 * schedule is a thing that spends money unattended, so a switch you can hit while
 * scrolling is the wrong affordance.
 */
export function ScheduleRail({
  schedules,
  total,
  workspaceNames,
  agentNames,
  runningThreadIds,
  search,
  onSearchChange,
  selectedId,
  onSelect,
  onActivate,
}: ScheduleRailProps) {
  const listRef = useRef<HTMLDivElement>(null)

  // A selection that scrolls out of view under arrow keys is unusable; keep the
  // focused row in the viewport whenever it changes.
  useEffect(() => {
    if (!selectedId) return
    listRef.current
      ?.querySelector(`[data-schedule-id="${selectedId}"]`)
      ?.scrollIntoView({ block: "nearest" })
  }, [selectedId])

  const move = useCallback(
    (delta: number) => {
      if (schedules.length === 0) return
      const index = schedules.findIndex((s) => s.id === selectedId)
      const next = index === -1 ? 0 : index + delta
      const clamped = Math.max(0, Math.min(schedules.length - 1, next))
      onSelect(schedules[clamped], "keyboard")
    },
    [schedules, selectedId, onSelect]
  )

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault()
      move(1)
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      move(-1)
    } else if (event.key === "Enter") {
      const current = schedules.find((s) => s.id === selectedId)
      if (current) {
        event.preventDefault()
        onActivate(current)
      }
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 border-b px-3 py-2.5">
        <div className="relative">
          <MagnifyingGlass className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search schedules"
            className="h-8 pl-8 text-sm"
            aria-label="Search schedules"
          />
        </div>
        <p className="text-[11px] text-muted-foreground">
          {schedules.length === total
            ? `${total} schedule${total === 1 ? "" : "s"}`
            : `${schedules.length} of ${total}`}
        </p>
      </div>

      <div
        ref={listRef}
        role="listbox"
        aria-label="Schedules"
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-y-auto focus:outline-none"
      >
        {schedules.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            Nothing matches that search.
          </p>
        ) : (
          schedules.map((schedule) => {
            const selected = schedule.id === selectedId
            const lastRun = schedule.last_run
            const problem = isFireProblem(lastRun?.status)
            const live = Boolean(
              lastRun?.thread_id && runningThreadIds.has(lastRun.thread_id)
            )
            return (
              <div
                key={schedule.id}
                data-schedule-id={schedule.id}
                role="option"
                aria-selected={selected}
                onClick={() => onSelect(schedule, "pointer")}
                onDoubleClick={() => onActivate(schedule)}
                className={cn(
                  "cursor-pointer border-b border-border/50 px-3 py-2.5 text-left transition-colors last:border-b-0",
                  selected ? "bg-accent" : "hover:bg-accent/50"
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    aria-hidden
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      live
                        ? "animate-pulse bg-primary"
                        : schedule.enabled
                          ? lastRun
                            ? FIRE_STATUS_DOT[lastRun.status]
                            : "bg-primary"
                          : "bg-muted-foreground/40"
                    )}
                  />
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-sm font-medium",
                      schedule.enabled
                        ? "text-foreground"
                        : "text-muted-foreground"
                    )}
                  >
                    {schedule.name}
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {live
                      ? "running"
                      : schedule.enabled
                        ? relativeTime(schedule.next_fire_at)
                        : "paused"}
                  </span>
                </div>

                <p className="mt-0.5 truncate pl-3.5 text-[11px] text-muted-foreground">
                  {workspaceNames.get(schedule.workspace_id) ?? "Unknown workspace"}
                  {" · "}
                  {agentNames.get(schedule.agent_id) ?? "Unknown agent"}
                  {" · "}
                  {runTypeSummary(schedule)}
                </p>

                {problem && lastRun ? (
                  <p className="mt-1 flex items-start gap-1 pl-3.5 text-[11px] leading-snug text-muted-foreground">
                    <WarningCircle className="mt-px h-3 w-3 shrink-0" />
                    <span className="min-w-0 flex-1">{fireSummary(lastRun)}</span>
                  </p>
                ) : null}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
