import {
  CaretDown,
  CaretRight,
  Folder,
  FolderOpen,
  Pencil,
  Trash,
} from "@phosphor-icons/react"
import type { DragEvent, ReactNode } from "react"

import type { WorkspaceFolder } from "@/api/types"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { cn } from "@/lib/utils"

interface FolderRowProps {
  folder: WorkspaceFolder
  collapsed: boolean
  /** An agent is working somewhere inside — rolled up from its members. Only
   *  shown while shut; see the marks note below. */
  running: boolean
  /** Replies waiting inside, likewise. */
  unreadCount: number
  containsActive: boolean
  onToggle: () => void
  onRename: () => void
  onDelete: () => void
  /** A workspace is hovering the header, about to be filed into this group. */
  isFileTarget?: boolean
  drag?: {
    draggable: boolean
    onDragStart: (event: DragEvent) => void
    onDragOver: (event: DragEvent) => void
    onDrop: (event: DragEvent) => void
    onDragEnd: () => void
    isDragging: boolean
    isDropTarget: boolean
  }
  /** The member rows, drawn by the section. */
  children?: ReactNode
}

/**
 * A group of projects inside PROJECTS.
 *
 * Folders were the one thing the reference UI has no room for — its PROJECTS list
 * is flat — and the plan's §5.2 kept them anyway: they are backend-held
 * (`workspace_folders`, `workspaces.position`), the drag logic already worked, and
 * silently dropping the feature would discard filing the user had done. So this is
 * the 68px `RailFolder` widened into a row, not a new idea.
 *
 * A shut group still shows the project you are *in*: the sidebar's job is to say
 * where you are, and a row that vanished because you tidied it away would take
 * that answer with it. The section decides which children to pass; this component
 * just renders them.
 *
 * Two things it owes the one-column sidebar it now lives in. It is the same height
 * and type size as a {@link ProjectRow}, because a group and a project are peers in
 * this list rather than a header and its rows. And the members hang off a guide
 * rail instead of being padded in: a project inside a group brings four session
 * rows of its own, and with indentation alone the group's contents ran to the same
 * left edge as everything else — you could not see where it ended. The rail costs
 * 17px and answers that outright, which matters in a 256px column.
 */
export function FolderRow({
  folder,
  collapsed,
  running,
  unreadCount,
  containsActive,
  onToggle,
  onRename,
  onDelete,
  isFileTarget,
  drag,
  children,
}: FolderRowProps) {
  const Caret = collapsed ? CaretRight : CaretDown
  // Open or shut, said by the glyph in the icon column — where a project row
  // carries the project's icon, so the two rows still scan as one list.
  const FolderIcon = collapsed ? Folder : FolderOpen

  return (
    <li className={cn(drag?.isDragging && "opacity-50")}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!collapsed}
            draggable={drag?.draggable}
            onDragStart={drag?.onDragStart}
            onDragOver={drag?.onDragOver}
            onDrop={drag?.onDrop}
            onDragEnd={drag?.onDragEnd}
            className={cn(
              // `pl-2 gap-2` and a 16px glyph, which is a ProjectRow's geometry
              // exactly: a group and a project are both root rows, so their names
              // share one column. It used to lead with a caret *and* an icon,
              // which pushed the group's name 12px right of every project name
              // above it — and past its own members, which the rail indents by
              // less. The state the caret was carrying is in the glyph now.
              "group/folder flex h-8 w-full min-w-0 select-none items-center gap-2 rounded-md pl-2 pr-1 text-sidebar-foreground outline-none ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2",
              containsActive && "font-medium",
              // "Before me" and "into me" are the same gesture with different
              // meanings, so they get different marks: a rule above for a
              // reorder, a full ring for a file-into.
              drag?.isDropTarget &&
                "border-t border-sidebar-primary rounded-t-none",
              isFileTarget &&
                "bg-sidebar-primary/15 ring-1 ring-inset ring-sidebar-primary"
            )}
          >
            <FolderIcon
              className="size-4 shrink-0 text-sidebar-foreground/70"
              weight={containsActive ? "fill" : "regular"}
            />
            <span className="min-w-0 flex-1 truncate text-left text-[13px] leading-5 tracking-tight">
              {folder.name}
            </span>
            {/* Marks only while shut, and nothing at all when open.
                A member count sat here and was cut: it restated a list that is
                directly below, and it counted projects while reading as sessions.
                The rolled-up dot and unread badge earn their slot for the same
                reason the count didn't — a shut group is hiding the rows that
                would have said it themselves. Open, every one of them is on
                screen carrying its own mark. */}
            {collapsed && running ? (
              <span
                aria-label="Agent working inside"
                className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary"
              />
            ) : collapsed && unreadCount > 0 ? (
              <span
                aria-label={`${unreadCount} unread inside`}
                className="min-w-4 shrink-0 rounded-full bg-sidebar-primary px-1 text-[10px] font-medium leading-4 tabular-nums text-sidebar-primary-foreground"
              >
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            ) : null}

            {/* Trailing caret, in the slot a project row keeps for its own. Held
                open while the group is shut — that is the state that needs
                advertising, since a shut group has no rows under it to imply
                one — and otherwise on hover, like everything else on this row. */}
            <span
              aria-hidden
              className={cn(
                "flex size-5 shrink-0 items-center justify-center text-sidebar-foreground/45",
                collapsed ? "opacity-100" : "opacity-0 group-hover/folder:opacity-100"
              )}
            >
              <Caret className="size-3" />
            </span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={onRename}>
            <Pencil className="size-4" />
            Rename folder
          </ContextMenuItem>
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={onDelete}
          >
            <Trash className="size-4" />
            Delete folder
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {children ? (
        // The rail. Everything inside the group — member rows and the sessions
        // under them — is measured from this line, so one border does the work
        // that per-row indentation could not: a project's sessions are already
        // indented under *it*, and adding a step for the group left the two
        // levels a few pixels apart and reading as one.
        <ul className="ml-3 flex min-w-0 flex-col border-l border-sidebar-border pl-1">
          {children}
        </ul>
      ) : null}
    </li>
  )
}
