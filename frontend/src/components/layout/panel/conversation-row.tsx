import { ChatCentered, Clock, Pencil, Trash } from "@phosphor-icons/react"
import type { MouseEvent } from "react"
import { Link } from "react-router-dom"

import type { Thread } from "@/api/types"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { DotGridLoader } from "@/components/ui/dot-grid-loader"
import type { RowHandlers } from "@/components/layout/panel/types"
import type { SelectMods } from "@/components/layout/use-sidebar-selection"
import type { ThreadState } from "@/hooks/use-thread-state"
import { timeAgo } from "@/lib/time-ago"
import { cn } from "@/lib/utils"

export interface ConversationRowProps extends RowHandlers {
  thread: Thread
  state: ThreadState
  /**
   * `compact` is one line for a workspace's own section. `stacked` gives the
   * `workspace · state · time` metadata its own line, which is why Activity
   * reads better in a 256px panel than the old single-line rows did.
   */
  variant?: "compact" | "stacked"
  /**
   * Which workspace it belongs to; only cross-workspace lists pass it. In
   * `compact` it takes the trailing slot *instead of* the timestamp — which
   * workspace beats how long ago when the list spans several, and there is only
   * room for one before the title starts truncating to nothing.
   */
  workspaceName?: string
  isSelected: boolean
  onSelect: (mods: SelectMods) => void
}

/**
 * One conversation in the sidebar panel.
 *
 * A plain click always opens the conversation — ⌘/ctrl toggles it in the bulk
 * selection and ⇧ extends a range, but nothing silently redefines an unmodified
 * click. (The old sidebar swallowed plain clicks into selection toggles once
 * anything was selected, with no cue on the row that it had.)
 */
export function ConversationRow({
  thread,
  state,
  variant = "compact",
  workspaceName,
  isSelected,
  selection,
  onSelect,
  onNavigate,
  onRename,
  onDelete,
}: ConversationRowProps) {
  const { isActive, running, unread } = state
  const stacked = variant === "stacked"

  const handleClick = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault()
      onSelect({ toggle: true, range: false })
    } else if (e.shiftKey) {
      e.preventDefault()
      onSelect({ toggle: false, range: true })
    } else {
      // Opening a conversation ends bulk selection rather than fighting it.
      if (selection.count > 0) selection.clear()
      onNavigate()
    }
  }

  const icon = running ? (
    <DotGridLoader size="xs" className="shrink-0 text-primary" label="Working" />
  ) : unread ? (
    <ChatCentered weight="fill" className="size-4 shrink-0 text-success" />
  ) : (
    <ChatCentered className="size-4 shrink-0 text-sidebar-foreground/60" />
  )

  const title = thread.title || "Untitled"

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <Link
            to={`/workspaces/${thread.workspace_id}/chat?c=${thread.id}`}
            onClick={handleClick}
            className={cn(
              "flex w-full min-w-0 select-none gap-2 rounded-md px-2 text-sm text-sidebar-foreground outline-none ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2",
              stacked ? "items-start py-1.5" : "h-7 items-center",
              isActive &&
                "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
              isSelected && "bg-primary/15 text-foreground hover:bg-primary/20"
            )}
          >
            <span
              className={cn(
                "flex shrink-0 items-center",
                stacked ? "h-5" : "h-full"
              )}
            >
              {icon}
            </span>

            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  "block truncate",
                  stacked && "leading-5",
                  running && "text-primary",
                  unread && "font-medium text-foreground"
                )}
              >
                {title}
              </span>
              {stacked ? (
                <span className="block truncate text-[11px] leading-4 text-muted-foreground">
                  {[
                    workspaceName,
                    running
                      ? "running"
                      : unread
                        ? "new reply"
                        : thread.schedule_id
                          ? "schedule"
                          : null,
                    timeAgo(thread.updated_at),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              ) : null}
            </span>

            {stacked ? null : (
              <>
                {/* Nobody started this one — a schedule did. Sits beside the
                    trailing metadata rather than replacing the leading icon,
                    which is the running/unread slot and carries the more urgent
                    signal. */}
                {thread.schedule_id ? (
                  <Clock
                    className="size-3 shrink-0 text-muted-foreground/70"
                    aria-label="Started by a schedule"
                  />
                ) : null}
                {workspaceName ? (
                  <span className="max-w-[45%] shrink-0 truncate text-[10px] text-muted-foreground/70">
                    {workspaceName}
                  </span>
                ) : (
                  <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
                    {timeAgo(thread.updated_at)}
                  </span>
                )}
              </>
            )}
          </Link>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => onRename(thread)}>
            <Pencil className="size-4" />
            Rename
          </ContextMenuItem>
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={() => onDelete(thread)}
          >
            <Trash className="size-4" />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </li>
  )
}
