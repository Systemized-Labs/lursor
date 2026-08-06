import {
  ArrowCounterClockwise,
  CaretDown,
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
 * It does not print its ⌘ digit. ⌘1–⌘9 still switch projects
 * (`use-workspace-switch`); the row just stops advertising it. A chord badge is
 * worth a slot on a row you are looking for and not on one you are reading past —
 * and with the caret now also on hover, two hint glyphs were arriving together on
 * the same edge every time the pointer crossed a project.
 *
 * **Two targets, two intents.** The name switches to the project (resuming the
 * session you were last in) *and* drills the list into it — "show me this
 * project" is one intent, so it is one click, and the rail this replaces earned
 * its keep as a one-click switcher. The caret only shows or hides this project's
 * sessions where they sit. Wanting a look at what is in a repo you are not in is
 * not the same as wanting to go there, and while the whole row was one link the
 * cheaper of those two asks cost a navigation, a drill, and a click back.
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
  collapsed,
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
  const Caret = collapsed ? CaretRight : CaretDown

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
                // else; anything else is a switch-and-drill.
                if (event.metaKey || event.ctrlKey || event.shiftKey) return
                event.preventDefault()
                onOpen()
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
              {/* Underlined on hover, because this half of the row goes
                  somewhere and the other half does not. Without it the two
                  targets look identical and you learn the difference by
                  being taken to a project you only wanted to peek at. */}
              <span className="min-w-0 flex-1 truncate text-[13px] leading-5 tracking-tight group-hover/name:underline">
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

            {/* On hover only, and it keeps its slot when hidden: a caret that
                appeared out of nowhere would shift the name under the cursor.
                Which way it points is not the state indicator — whether the
                sessions are there is. */}
            {onToggleCollapsed ? (
              <button
                type="button"
                onClick={onToggleCollapsed}
                aria-expanded={!collapsed}
                aria-label={
                  collapsed
                    ? `Show ${workspace.name} sessions`
                    : `Hide ${workspace.name} sessions`
                }
                className="flex size-5 shrink-0 items-center justify-center rounded text-sidebar-foreground/45 opacity-0 outline-none ring-sidebar-ring hover:bg-sidebar-border/60 hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:ring-2 group-hover/project:opacity-100"
              >
                <Caret className="size-3" />
              </button>
            ) : (
              <span aria-hidden className="size-5 shrink-0" />
            )}
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
