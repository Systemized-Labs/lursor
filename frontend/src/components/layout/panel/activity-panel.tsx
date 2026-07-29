import { useMemo, useState } from "react"

import type { Thread } from "@/api/types"
import { ConversationRow } from "@/components/layout/panel/conversation-row"
import type { ConversationHandlers } from "@/components/layout/panel/types"
import { cn } from "@/lib/utils"

type ActivityFilter = "all" | "running" | "unread" | "scheduled"

const FILTERS: { key: ActivityFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "running", label: "Running" },
  { key: "unread", label: "Unread" },
  { key: "scheduled", label: "Scheduled" },
]

interface ActivityPanelProps extends ConversationHandlers {
  allThreads: Thread[]
  workspaceName: (workspaceId: string) => string
  isLoading: boolean
}

/**
 * A flat, cross-workspace list of what has been happening, newest first.
 *
 * Two-line rows are the point: `workspace · state · time` gets its own line
 * instead of fighting the title for a 256px column. Scheduled is worth its own
 * filter because scheduled runs are the ones you never go looking for.
 *
 * Opening a row navigates to the conversation and leaves the panel on Activity
 * — the panel mode is sidebar state, not something the route derives.
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

  return (
    <div className="flex flex-col gap-1 px-2 pb-2">
      <div className="flex flex-wrap items-center gap-1 py-1">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={cn(
              "rounded-full px-2 py-0.5 text-xs transition-colors",
              filter === f.key
                ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                : "text-sidebar-foreground/70 hover:text-sidebar-foreground"
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">
          {filter === "all" ? "No conversations yet." : "Nothing here."}
        </p>
      ) : (
        <ul className="flex min-w-0 flex-col">
          {rows.map((thread) => (
            <ConversationRow
              key={thread.id}
              thread={thread}
              state={threadState(thread)}
              variant="stacked"
              workspaceName={workspaceName(thread.workspace_id)}
              isSelected={selection.isThreadSelected(thread.id)}
              onSelect={(mods) => selection.selectThread(thread, mods, rows)}
              {...handlers}
            />
          ))}
        </ul>
      )}
    </div>
  )
}
