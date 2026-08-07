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
  href: string
  icon: WorkspaceIconDef
  hasIconOverride: boolean
  isActive: boolean
  running: boolean
  /** Its sessions are hidden. Undefined where the row has none to hide. */
  collapsed?: boolean
  folders: { id: string; name: string }[]
  onOpen: () => void
  /** Show or hide this project's sessions, without going to the project. */
  onToggleCollapsed?: () => void
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
 * name outright and still has room for the icon and the status dot.
 *
 * It does not print a ⌘ digit. ⌘1–⌘9 switch pane tabs now (see `pane-host.tsx`),
 * not workspaces. A chord badge was worth a slot on a row you are looking for
 * and not on one you are reading past — and with the caret now also on hover,
 * two hint glyphs were arriving together on the same edge every time the pointer
 * crossed a project.
 *
 * **Two targets, two intents.** The name shows or hides this project's sessions
 * inline — a quick peek at what is in a repo without leaving the one you are in.
 * The arrow opens the workspace, switching to it and drilling the sidebar list
 * into its sessions. Browsing and committing are different asks, and splitting
 * them across the row's two halves keeps each one a single click.
 *
 * They are siblings rather than nested, because a button inside an anchor is
 * invalid HTML and browsers resolve it by giving the click to whichever they feel
 * like. The row's box is a plain div: it carries the hover background and the drag
 * handlers, so both halves still read as one row.
 */
export function ProjectRow({
  workspace,
  href,
  icon,
  hasIconOverride,
  isActive,
  running,
  folders,
  onOpen,
  onToggleCollapsed,
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
          <div
            draggable={drag?.draggable}
            onDragStart={drag?.onDragStart}
            onDragOver={drag?.onDragOver}
            onDrop={drag?.onDrop}
            onDragEnd={drag?.onDragEnd}
            className={cn(
              "group/project flex h-8 w-full min-w-0 select-none items-center rounded-md pr-1 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
              isActive &&
                "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
              drag?.isDropTarget && "ring-1 ring-sidebar-ring"
            )}
          >
            <Link
              to={href}
              onClick={(event) => {
                // Let ⌘/ctrl-click and middle-click do what they do everywhere
                // else; anything else toggles the sessions inline.
                if (event.metaKey || event.ctrlKey || event.shiftKey) return
                event.preventDefault()
                onToggleCollapsed?.()
              }}
              aria-current={isActive ? "page" : undefined}
              // An anchor is a drag source by default, and the thing it drags is
              // its href — which would beat the row's own drag to filing a
              // project into a group. The row is the handle; the link is not.
              draggable={false}
              // No indent of its own inside a folder: the group draws a rail and
              // measures its members from that (`folder-row.tsx`). A row that
              // padded itself as well sat further in than the sessions it owns.
              className="group/name flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pl-2 outline-none ring-sidebar-ring focus-visible:ring-2"
            >
              <Icon
                className="size-4 shrink-0 text-sidebar-foreground/70"
                weight={isActive ? "fill" : "regular"}
              />
              {/* No underline: this half of the row toggles the project's
                  sessions inline rather than navigating anywhere. The arrow
                  on the other end is the one that goes somewhere. */}
              <span className="min-w-0 flex-1 truncate text-[13px] leading-5 tracking-tight">
                {workspace.name}
              </span>

              {/* The live fact, and the only mark left on the row: an agent is
                  working in here. The unread count that used to sit beside it is
                  gone — the sessions it was counting are listed directly below,
                  each carrying its own mark, so the number was restating what the
                  rows already showed. */}
              {running ? (
                <span
                  aria-label="Agent working"
                  className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary"
                />
              ) : null}
            </Link>

            {/* Same hover-only treatment as the caret beside it. Starting a
                conversation in a project you can see is the one thing the row
                was still sending you through the context menu for. */}
            <button
              type="button"
              onClick={onNewConversation}
              aria-label={`New conversation in ${workspace.name}`}
              title="New conversation"
              className="flex size-5 shrink-0 items-center justify-center rounded text-sidebar-foreground/45 opacity-0 outline-none ring-sidebar-ring hover:bg-sidebar-border/60 hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:ring-2 group-hover/project:opacity-100"
            >
              <Plus className="size-3" />
            </button>

            {/* On hover only: the arrow opens this workspace in its own
                sidebar, switching to it and drilling the list into its
                sessions. Always rendered — opening a workspace is always a
                meaningful action, even one with no sessions yet. */}
            <button
              type="button"
              onClick={onOpen}
              aria-label={`Open ${workspace.name}`}
              title="Open workspace"
              className="flex size-5 shrink-0 items-center justify-center rounded text-sidebar-foreground/45 opacity-0 outline-none ring-sidebar-ring hover:bg-sidebar-border/60 hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:ring-2 group-hover/project:opacity-100"
            >
              <CaretRight className="size-3" />
            </button>
          </div>
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
