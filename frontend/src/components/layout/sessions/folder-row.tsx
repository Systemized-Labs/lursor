import { CaretDown, CaretRight, Folder, Pencil, Trash } from "@phosphor-icons/react"
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
  childCount: number
  /** An agent is working somewhere inside — rolled up from its members. */
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
 */
export function FolderRow({
  folder,
  collapsed,
  childCount,
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
              "flex h-7 w-full min-w-0 select-none items-center gap-1.5 rounded-md pl-1 pr-1.5 text-sidebar-foreground/80 outline-none ring-sidebar-ring hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground focus-visible:ring-2",
              containsActive && "text-sidebar-foreground",
              // "Before me" and "into me" are the same gesture with different
              // meanings, so they get different marks: a rule above for a
              // reorder, a full ring for a file-into.
              drag?.isDropTarget &&
                "border-t border-sidebar-primary rounded-t-none",
              isFileTarget &&
                "bg-sidebar-primary/15 ring-1 ring-inset ring-sidebar-primary"
            )}
          >
            <Caret className="size-3 shrink-0 text-sidebar-foreground/45" />
            <Folder
              className="size-3.5 shrink-0 text-sidebar-foreground/55"
              weight={containsActive ? "fill" : "regular"}
            />
            <span className="min-w-0 flex-1 truncate text-left text-[12px] leading-5">
              {folder.name}
            </span>
            {running ? (
              <span
                aria-label="Agent working inside"
                className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary"
              />
            ) : unreadCount > 0 ? (
              <span
                aria-label={`${unreadCount} unread inside`}
                className="min-w-4 shrink-0 rounded-full bg-sidebar-primary px-1 text-[10px] font-medium leading-4 tabular-nums text-sidebar-primary-foreground"
              >
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            ) : (
              <span className="shrink-0 text-[10px] tabular-nums text-sidebar-foreground/35">
                {childCount}
              </span>
            )}
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

      {children ? <ul className="flex min-w-0 flex-col">{children}</ul> : null}
    </li>
  )
}
