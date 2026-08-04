import { Clock, Pencil, PushPin, PushPinSlash, Trash } from "@phosphor-icons/react"
import type { MouseEvent } from "react"
import { Link } from "react-router-dom"

import type { Thread } from "@/api/types"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import type { RowHandlers } from "@/components/layout/panel/types"
import type { SelectMods } from "@/components/layout/use-sidebar-selection"
import type { ThreadState } from "@/hooks/use-thread-state"
import { requestOpenThread } from "@/lib/open-thread"
import { timeAgo } from "@/lib/time-ago"
import { cn } from "@/lib/utils"

export interface ConversationRowProps
  // The pin pair is re-declared below with a row's shape: `RowHandlers` carries
  // them keyed by thread id, because a *list* has to answer for many rows.
  extends Omit<RowHandlers, "isPinned" | "onTogglePin"> {
  thread: Thread
  state: ThreadState
  /**
   * `compact` is one line for a workspace's own list. `stacked` gives the
   * `workspace · time` metadata its own line, which is why Activity reads better
   * in a 256px panel than a single-line row would.
   */
  variant?: "compact" | "stacked"
  /** Which workspace it belongs to; only cross-workspace lists pass it. */
  workspaceName?: string
  isSelected: boolean
  onSelect: (mods: SelectMods) => void
  /** Pinned to the top of the sidebar. Undefined where pinning has no meaning. */
  isPinned?: boolean
  onTogglePin?: () => void
}

/**
 * One conversation in the sidebar panel.
 *
 * The status marker is a 3px gutter rule rather than an icon. Every row used to
 * carry the same chat bubble, which meant the leading column — the most valuable
 * strip in the list, the one your eye rides down — spent itself restating a fact
 * that was already true of every row. A rule uses that column for the thing that
 * actually differs: filled and pulsing while an agent works, filled while a
 * reply is unread, hairline once read. Thirty rows now have a scannable left
 * edge instead of thirty identical bubbles.
 *
 * A plain click always opens the conversation — ⌘/ctrl toggles it in the bulk
 * selection and ⇧ extends a range, but nothing silently redefines an unmodified
 * click.
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
  isPinned,
  onTogglePin,
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
      // The `href` still navigates — it has to, since the conversation may live in
      // another workspace and the pane layer is keyed on that. But the pane itself
      // is addressed through the request channel, because a pane reads its thread
      // from its own params rather than from `?c=`.
      requestOpenThread({ workspaceId: thread.workspace_id, threadId: thread.id })
      onNavigate()
    }
  }

  const title = thread.title || "Untitled"

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <Link
            to={`/workspaces/${thread.workspace_id}/chat?c=${thread.id}`}
            onClick={handleClick}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "group/row relative flex w-full min-w-0 select-none gap-2 rounded-md pl-2.5 pr-2 text-sidebar-foreground outline-none ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2",
              stacked ? "flex-col py-1.5" : "h-7 items-center",
              isActive &&
                "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
              isSelected && "bg-primary/15 text-foreground hover:bg-primary/20"
            )}
          >
            {/* The status gutter. `running` outranks `unread`: a working agent is
                the live fact, and a row cannot be both waiting and arriving. */}
            <span
              aria-hidden
              className={cn(
                "absolute inset-y-1 left-0.5 w-[3px] rounded-full transition-colors",
                running
                  ? "animate-pulse bg-primary"
                  : unread
                    ? "bg-success"
                    : isActive
                      ? "bg-sidebar-primary/60"
                      : "bg-sidebar-border group-hover/row:bg-sidebar-foreground/25"
              )}
            />

            <span
              className={cn(
                "block min-w-0 max-w-full truncate text-[13px] leading-5 tracking-tight",
                running && "text-primary",
                unread && "font-medium text-foreground"
              )}
            >
              {title}
            </span>

            {isPinned ? (
              <PushPin
                aria-label="Pinned"
                className={cn(
                  "size-3 shrink-0 text-sidebar-foreground/45",
                  stacked && "absolute right-2 top-2"
                )}
              />
            ) : null}

            {stacked ? (
              // Metadata in its own line, with the workspace given the room to
              // be read — it is the only thing distinguishing `cat-adoption`'s
              // "Tell Me A Joke" from `cat-landing`'s.
              <span className="flex w-full min-w-0 items-baseline gap-1.5 text-[10px] leading-4">
                <span className="min-w-0 flex-1 truncate uppercase tracking-[0.06em] text-sidebar-foreground/60">
                  {workspaceName}
                </span>
                {thread.schedule_id ? (
                  <Clock
                    className="size-3 shrink-0 text-sidebar-foreground/45"
                    aria-label="Started by a schedule"
                  />
                ) : null}
                {/* Right-aligned and tabular so the times form a column that can
                    be read straight down instead of zig-zagging after each
                    title. */}
                <span className="shrink-0 tabular-nums text-sidebar-foreground/45">
                  {running ? "live" : timeAgo(thread.updated_at)}
                </span>
              </span>
            ) : (
              <>
                {thread.schedule_id ? (
                  <Clock
                    className="size-3 shrink-0 text-sidebar-foreground/45"
                    aria-label="Started by a schedule"
                  />
                ) : null}
                <span className="ml-auto shrink-0 text-[10px] tabular-nums text-sidebar-foreground/45">
                  {running ? "live" : timeAgo(thread.updated_at)}
                </span>
              </>
            )}
          </Link>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {/* Pinning lives here rather than on ⇧-click, which the plan's §5
              suggested: ⇧-click already extends a range in the bulk selection,
              and a modifier cannot mean two things on the same row. */}
          {onTogglePin ? (
            <ContextMenuItem onSelect={onTogglePin}>
              {isPinned ? (
                <PushPinSlash className="size-4" />
              ) : (
                <PushPin className="size-4" />
              )}
              {isPinned ? "Unpin" : "Pin"}
            </ContextMenuItem>
          ) : null}
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
