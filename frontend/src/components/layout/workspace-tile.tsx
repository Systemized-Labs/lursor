import { GitBranch, Pencil, Plus, Trash } from "@phosphor-icons/react"
import type { ComponentType, DragEvent, MouseEvent } from "react"
import { Link } from "react-router-dom"

import type { Workspace } from "@/api/types"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/**
 * Up to two initials for the tile face. Words first ("hyve web" → HW), which
 * discriminates better than the first two letters when repos share a prefix;
 * a single word keeps its first two characters ("lursor" → LU).
 */
function monogram(name: string): string {
  const words = name.split(/[\s\-_./]+/).filter(Boolean)
  if (words.length === 0) return "?"
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}

interface WorkspaceTileProps {
  workspace: Workspace
  /** Its rail position, for the ⌘N hint. Zero-based; hint shown for 0–8. */
  index: number
  href: string
  isActive: boolean
  /** An agent is working in this workspace right now. */
  running: boolean
  /** Replies that landed here and you haven't looked at. */
  unreadCount: number
  /** Stands in for the monogram — the Skill Studio is a workspace with an icon. */
  icon?: ComponentType<{ className?: string }>
  onOpen: () => void
  onNewConversation: () => void
  onRename: () => void
  onClone: () => void
  onDelete: () => void
  /** Omitted for the studio tile, which is pinned below the draggable ones. */
  drag?: {
    onDragStart: (e: DragEvent) => void
    onDragOver: (e: DragEvent) => void
    onDrop: (e: DragEvent) => void
    onDragEnd: () => void
    isDragging: boolean
    isDropTarget: boolean
  }
}

/**
 * One workspace in the rail: monogram (or icon), name, and how it's doing.
 *
 * The status marks are the reason workspaces belong in the rail rather than
 * behind a switcher. Working in one repo while agents run in another is the
 * normal case, and a popover you have to open to check on them is not a status
 * board. So a tile carries both signals a glance needs — something is running
 * here, and something finished here that you haven't read — and the rail stops
 * being only navigation.
 *
 * The name rides under the monogram at the same 10px the destination tiles used,
 * which is what makes near-identical repo names survivable at 68px: the
 * monogram is the thing you actually aim at, and the label is there to confirm
 * it rather than to be read every time.
 */
export function WorkspaceTile({
  workspace,
  index,
  href,
  isActive,
  running,
  unreadCount,
  icon: Icon,
  onOpen,
  onNewConversation,
  onRename,
  onClone,
  onDelete,
  drag,
}: WorkspaceTileProps) {
  const handleClick = (e: MouseEvent) => {
    // Let the browser own anything that isn't a plain click, so ⌘-click and
    // middle-click still open a workspace in a new window.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    onOpen()
  }

  const hint = index < 9 ? `⌘${index + 1}` : undefined

  const tile = (
    <Link
      to={href}
      onClick={handleClick}
      draggable={Boolean(drag)}
      onDragStart={drag?.onDragStart}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
      onDragEnd={drag?.onDragEnd}
      aria-current={isActive ? "page" : undefined}
      aria-label={
        unreadCount > 0
          ? `${workspace.name}, ${unreadCount} unread`
          : workspace.name
      }
      className={cn(
        "relative flex w-full flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-sidebar-foreground/70 outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2",
        isActive && "bg-sidebar-accent text-sidebar-accent-foreground",
        drag?.isDragging && "opacity-40",
        // A line above the drop position, rather than moving the tiles under the
        // cursor — the whole rail is built on positions holding still.
        drag?.isDropTarget &&
          "before:absolute before:-top-0.5 before:inset-x-1 before:h-0.5 before:rounded-full before:bg-sidebar-primary"
      )}
    >
      {isActive ? (
        <span
          aria-hidden
          className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-sidebar-primary"
        />
      ) : null}

      <span className="relative">
        {Icon ? (
          <Icon className="size-5" />
        ) : (
          <span
            aria-hidden
            className={cn(
              "flex size-6 items-center justify-center rounded-md border border-sidebar-border text-[10px] font-semibold tabular-nums",
              isActive && "border-sidebar-primary/50"
            )}
          >
            {monogram(workspace.name)}
          </span>
        )}

        {/* Running wins the slot: it is the live signal, and an unread count
            beside a spinner would be counting replies you're watching arrive.
            A plain pulsing dot rather than the app's dot-grid loader — at this
            size the 3×3 grid is wider than the monogram it sits on and blots out
            the letters, which are the thing you actually aim at. It clears the
            tile's corner entirely so the marks never cost legibility. */}
        {running ? (
          <span
            aria-hidden
            className="absolute -right-1 -top-0.5 size-2 animate-pulse rounded-full bg-primary ring-2 ring-sidebar-accent/40"
          />
        ) : unreadCount > 0 ? (
          <span
            aria-hidden
            className="absolute -right-2.5 -top-1.5 min-w-4 rounded-full bg-sidebar-primary px-1 text-[10px] font-medium leading-4 tabular-nums text-sidebar-primary-foreground ring-2 ring-sidebar-accent/40"
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        ) : null}
      </span>

      <span
        className={cn(
          "w-full truncate text-center text-[10px] leading-tight",
          isActive && "font-medium"
        )}
      >
        {workspace.name}
      </span>
    </Link>
  )

  return (
    <Tooltip>
      <ContextMenu>
        <TooltipTrigger asChild>
          <ContextMenuTrigger asChild>{tile}</ContextMenuTrigger>
        </TooltipTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={onNewConversation}>
            <Plus className="size-4" />
            New conversation
          </ContextMenuItem>
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

      {/* The label truncates at 68px, so the tooltip is where the full name
          lives — plus the shortcut, which has nowhere else to be shown. */}
      <TooltipContent side="right" align="center">
        {workspace.name}
        {hint ? (
          <span className="ml-2 text-muted-foreground">{hint}</span>
        ) : null}
      </TooltipContent>
    </Tooltip>
  )
}
