import { useMemo, useState } from "react"

import type { Thread } from "@/api/types"
import { ConversationRow } from "@/components/layout/panel/conversation-row"
import type { ConversationHandlers } from "@/components/layout/panel/types"
import { cn } from "@/lib/utils"

type ActivityFilter = "all" | "running" | "unread" | "scheduled"

const FILTERS: { key: ActivityFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "running", label: "Run" },
  { key: "unread", label: "New" },
  { key: "scheduled", label: "Sched" },
]

/** Coarse buckets, newest first — the grain you actually ask "when" at. */
const BUCKETS = [
  { key: "now", label: "Live", hours: 0 },
  { key: "today", label: "Today", hours: 24 },
  { key: "week", label: "This week", hours: 24 * 7 },
  { key: "older", label: "Earlier", hours: Infinity },
] as const

interface ActivityPanelProps extends ConversationHandlers {
  allThreads: Thread[]
  workspaceName: (workspaceId: string) => string
  isLoading: boolean
}

/**
 * A cross-workspace log of what has been happening, newest first.
 *
 * Grouped, because an ungrouped list of thirty rows reading `1h`, `2h`, `21h`,
 * `1d` makes you compute the boundary yourself on every scan — the timestamps
 * were doing a job a heading does better. Anything running sits in its own group
 * at the top, so the one bucket you might act on is never mixed into history.
 *
 * The filter labels are abbreviated to hold one line. At their full width
 * ("Running", "Scheduled") the row wrapped, and a wrapped segmented control
 * reads as a layout bug rather than as four choices.
 */
export function ActivityPanel({
  allThreads,
  workspaceName,
  isLoading,
  ...handlers
}: ActivityPanelProps) {
  const { threadState, selection } = handlers
  const [filter, setFilter] = useState<ActivityFilter>("all")

  const rows = useMemo(() => {
    if (filter === "all") return allThreads
    return allThreads.filter((thread) => {
      if (filter === "scheduled") return Boolean(thread.schedule_id)
      return threadState(thread)[filter]
    })
  }, [allThreads, filter, threadState])

  // One pass into buckets. `allThreads` already arrives newest-first, so each
  // bucket stays ordered without a second sort.
  const groups = useMemo(() => {
    const now = Date.now()
    const buckets = new Map<string, Thread[]>()
    for (const thread of rows) {
      const { running } = threadState(thread)
      const ageHours = (now - Date.parse(thread.updated_at)) / 3_600_000
      const bucket = running
        ? "now"
        : (BUCKETS.find((b) => ageHours < b.hours)?.key ?? "older")
      const list = buckets.get(bucket)
      if (list) list.push(thread)
      else buckets.set(bucket, [thread])
    }
    return BUCKETS.map((b) => ({ ...b, threads: buckets.get(b.key) ?? [] })).filter(
      (g) => g.threads.length > 0
    )
  }, [rows, threadState])

  return (
    <div className="flex flex-col px-2 pb-2">
      {/* Segmented, on one line, with the count riding on the active segment so
          "how many of these are there" costs no extra row. */}
      <div className="mb-1 flex items-center gap-px rounded-md bg-sidebar-accent/40 p-0.5">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            aria-pressed={filter === f.key}
            className={cn(
              "flex-1 rounded-[5px] px-1 py-1 text-[10px] font-medium uppercase tracking-[0.08em] transition-colors",
              filter === f.key
                ? "bg-sidebar text-sidebar-accent-foreground shadow-(--sh-xs)"
                : "text-sidebar-foreground/55 hover:text-sidebar-foreground"
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</p>
      ) : groups.length === 0 ? (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">
          {filter === "all" ? "No conversations yet." : "Nothing here."}
        </p>
      ) : (
        groups.map((group) => (
          <section key={group.key} className="min-w-0">
            {/* A ruled heading: the label sets the group, the hairline carries the
                eye across to the count. Cheap structure, and it reads the same in
                every theme because it is a border, not a color. */}
            <h3 className="flex items-center gap-2 px-1 pb-1 pt-2.5">
              <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.1em] text-sidebar-foreground/55">
                {group.label}
              </span>
              <span
                aria-hidden
                className="h-px min-w-2 flex-1 bg-sidebar-border"
              />
              <span className="shrink-0 text-[10px] tabular-nums text-sidebar-foreground/40">
                {group.threads.length}
              </span>
            </h3>
            <ul className="flex min-w-0 flex-col">
              {group.threads.map((thread) => (
                <ConversationRow
                  key={thread.id}
                  thread={thread}
                  state={threadState(thread)}
                  variant="stacked"
                  workspaceName={workspaceName(thread.workspace_id)}
                  isSelected={selection.isThreadSelected(thread.id)}
                  onSelect={(mods) =>
                    selection.selectThread(thread, mods, group.threads)
                  }
                  {...handlers}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  )
}
