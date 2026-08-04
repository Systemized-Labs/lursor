import {
  ArrowCounterClockwise,
  CaretRight,
  FolderOpen,
  GitBranch,
  Pencil,
  Plus,
  Trash,
} from "@phosphor-icons/react"
import { Link } from "react-router-dom"

import type { Workspace } from "@/api/types"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { WORKSPACE_ICONS, type WorkspaceIconDef } from "@/lib/workspace-icon"
import { cn } from "@/lib/utils"

export interface ProjectRowProps {
  workspace: Workspace
  /** The ⌘N slot, 1-based, or 0 for "past the ninth". */
  slot: number
  href: string
  icon: WorkspaceIconDef
  hasIconOverride: boolean
  isActive: boolean
  running: boolean
  unreadCount: number
  /** Indented, because it sits inside a folder. */
  nested?: boolean
  folders: { id: string; name: string }[]
  onOpen: () => void
  onSetIcon: (key: string | null) => void
  onMoveToFolder: (folderId: string | null) => void
  onNewConversation: () => void
  onRename: () => void
  onClone: () => void
  onDelete: () => void
  drag?: {
    draggable: boolean
    onDragStart: (event: React.DragEvent) => void
    onDragOver: (event: React.DragEvent) => void
    onDrop: (event: React.DragEvent) => void
    onDragEnd: (event: React.DragEvent) => void
    isDropTarget: boolean
  }
}

/**
 * One project in the PROJECTS list.
 *
 * Replaces the 68px `WorkspaceTile`. The tile spent its width on an icon and put
 * the name underneath at 10px, truncated — which is why `cat-adoption` and
 * `cat-landing` could only be told apart by hovering. A full-width row says the
 * name outright and still has room for the icon, the status dot and the ⌘ digit.
 *
 * Clicking it does two things: switches to the project (resuming the session you
 * were last in) *and* drills the section into it. The plan's §5 described only the
 * drill, but the rail this replaces earned its keep as a one-click switcher and
 * losing that would be a downgrade dressed as a redesign. "Show me this project"
 * is one intent, so it is one click.
 */
export function ProjectRow({
  workspace,
  slot,
  href,
  icon,
  hasIconOverride,
  isActive,
  running,
  unreadCount,
  nested,
  folders,
  onOpen,
  onSetIcon,
  onMoveToFolder,
  onNewConversation,
  onRename,
  onClone,
  onDelete,
  drag,
}: ProjectRowProps) {
  const Icon = icon.Icon

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <Link
            to={href}
            onClick={(event) => {
              // Let ⌘/ctrl-click and middle-click do what they do everywhere
              // else; anything else is a switch-and-drill.
              if (event.metaKey || event.ctrlKey || event.shiftKey) return
              event.preventDefault()
              onOpen()
            }}
            aria-current={isActive ? "page" : undefined}
            draggable={drag?.draggable}
            onDragStart={drag?.onDragStart}
            onDragOver={drag?.onDragOver}
            onDrop={drag?.onDrop}
            onDragEnd={drag?.onDragEnd}
            className={cn(
              "group/project flex h-8 w-full min-w-0 select-none items-center gap-2 rounded-md pl-2 pr-1.5 text-sidebar-foreground outline-none ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2",
              nested && "pl-5",
              isActive &&
                "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
              drag?.isDropTarget && "ring-1 ring-sidebar-ring"
            )}
          >
            <Icon
              className="size-4 shrink-0 text-sidebar-foreground/70"
              weight={isActive ? "fill" : "regular"}
            />
            <span className="min-w-0 flex-1 truncate text-[13px] leading-5 tracking-tight">
              {workspace.name}
            </span>

            {/* Status, then count, then the digit — in the order you ask for
                them. A working agent outranks an unread reply for the same
                reason it does on a conversation row: it is the live fact. */}
            {running ? (
              <span
                aria-label="Agent working"
                className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary"
              />
            ) : unreadCount > 0 ? (
              <span
                aria-label={`${unreadCount} unread`}
                className="min-w-4 shrink-0 rounded-full bg-sidebar-primary px-1 text-[10px] font-medium leading-4 tabular-nums text-sidebar-primary-foreground"
              >
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            ) : null}

            {/* Only the addressable ones. A tenth project showing a blank slot
                where a digit goes would imply a shortcut that does nothing. */}
            {slot > 0 && slot <= 9 ? (
              <span
                aria-hidden
                className="shrink-0 text-[10px] tabular-nums text-sidebar-foreground/35 opacity-0 group-hover/project:opacity-100"
              >
                ⌘{slot}
              </span>
            ) : null}

            <CaretRight className="size-3 shrink-0 text-sidebar-foreground/30" />
          </Link>
        </ContextMenuTrigger>

        {/* Ported wholesale from WorkspaceTile: the icon grid, filing without
            dragging, and the studio's protection from deletion. */}
        <ContextMenuContent className="w-56">
          <div className="scrollbar-hover grid max-h-52 grid-cols-8 gap-0.5 overflow-y-auto p-1">
            {WORKSPACE_ICONS.map((choice) => {
              const ChoiceIcon = choice.Icon
              const selected = choice.key === icon.key
              return (
                <ContextMenuItem
                  key={choice.key}
                  onSelect={() => onSetIcon(choice.key)}
                  aria-label={
                    selected ? `${choice.label} (current)` : choice.label
                  }
                  title={choice.label}
                  className={cn(
                    "size-7 justify-center rounded p-0 text-foreground/70 [&_svg]:size-[17px]",
                    selected && "bg-accent text-foreground ring-1 ring-ring"
                  )}
                >
                  <ChoiceIcon weight={selected ? "fill" : "regular"} />
                </ContextMenuItem>
              )
            })}
          </div>
          {hasIconOverride ? (
            <ContextMenuItem onSelect={() => onSetIcon(null)}>
              <ArrowCounterClockwise className="size-4" />
              Reset icon
            </ContextMenuItem>
          ) : null}

          <ContextMenuSeparator />

          <ContextMenuItem onSelect={onNewConversation}>
            <Plus className="size-4" />
            New conversation
          </ContextMenuItem>
          {/* Filing without dragging. Dragging is the fast path on a mouse but
              the *only* path on a phone, where HTML5 drag events never fire. */}
          {folders.length > 0 ? (
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <FolderOpen className="size-4" />
                Move to
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="w-52">
                {folders.map((folder) => (
                  <ContextMenuItem
                    key={folder.id}
                    disabled={folder.id === workspace.folder_id}
                    onSelect={() => onMoveToFolder(folder.id)}
                  >
                    <span className="truncate">{folder.name}</span>
                  </ContextMenuItem>
                ))}
                {workspace.folder_id ? (
                  <>
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={() => onMoveToFolder(null)}>
                      Top level
                    </ContextMenuItem>
                  </>
                ) : null}
              </ContextMenuSubContent>
            </ContextMenuSub>
          ) : null}
          <ContextMenuItem onSelect={onRename}>
            <Pencil className="size-4" />
            Rename
          </ContextMenuItem>
          <ContextMenuItem onSelect={onClone}>
            <GitBranch className="size-4" />
            Clone repo
          </ContextMenuItem>
          {/* The studio is app-owned: renaming is fine, deleting is not. */}
          {workspace.is_system ? null : (
            <ContextMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={onDelete}
            >
              <Trash className="size-4" />
              Delete
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
    </li>
  )
}
