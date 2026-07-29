import {
  ArrowCounterClockwise,
  FolderOpen,
  GitBranch,
  Pencil,
  Plus,
  Trash,
} from "@phosphor-icons/react"
import type { DragEvent, MouseEvent } from "react"
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { WORKSPACE_ICONS, type WorkspaceIconDef } from "@/lib/workspace-icon"
import { cn } from "@/lib/utils"

interface WorkspaceTileProps {
  workspace: Workspace
  /** Rail position, zero-based. Drives the index mark and the ⌘N hint. */
  index: number
  href: string
  /** The icon this workspace wears — its own choice or a keyword default. */
  icon: WorkspaceIconDef
  /** Whether an explicit choice is set, so "Reset" can be offered only if it is. */
  hasIconOverride: boolean
  isActive: boolean
  /** An agent is working in this workspace right now. */
  running: boolean
  /** Replies that landed here and you haven't looked at. */
  unreadCount: number
  onOpen: () => void
  onSetIcon: (key: string | null) => void
  onNewConversation: () => void
  onRename: () => void
  onClone: () => void
  onDelete: () => void
  /** The rail is wide enough to carry the name beside the icon. */
  expanded?: boolean
  /** Filed inside a folder, so the row is indented under its header. */
  nested?: boolean
  /** The groups this workspace could be filed into, for the "Move to" submenu. */
  folders?: { id: string; name: string }[]
  /** Refile it: a folder id, or null for the top level. */
  onMoveToFolder?: (folderId: string | null) => void
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
 * One workspace in the rail: an icon, its slot number, and how it's doing.
 *
 * No name on the face. That is the conclusion of having tried twice: about five
 * characters of the shell's display font fit across 68px, and workspace names run
 * to eleven or more, so `cat-adoption`, `cat-landing` and `cat-lovers` rendered
 * identically whether abbreviated to `CL` or wrapped to `cat-`/`land…`. Text at
 * this width cannot distinguish them, so identity moves to a glyph that can.
 *
 * The number stays, doing two jobs the icon can't: it is unique no matter how
 * many workspaces share an icon, and it is the ⌘N shortcut, so the rail teaches
 * the keyboard rather than hiding it in a tooltip. The name is one hover away and
 * always shown in the panel header beside it, so nothing is actually lost —
 * only moved off a surface too narrow to hold it.
 *
 * `expanded` is that surface finally being wide enough (⇧⌘B, 232px): the name
 * comes out of the tooltip and onto the face, and the slot number moves from
 * under the icon to the end of the row, where it yields to a status mark when
 * there is one. Nothing about identity changes — the same glyph in the same
 * order — so widening the rail doesn't make you re-learn it.
 */
export function WorkspaceTile({
  workspace,
  index,
  href,
  icon,
  hasIconOverride,
  isActive,
  running,
  unreadCount,
  onOpen,
  onSetIcon,
  onNewConversation,
  onRename,
  onClone,
  onDelete,
  expanded = false,
  nested = false,
  folders = [],
  onMoveToFolder,
  drag,
}: WorkspaceTileProps) {
  const handleClick = (e: MouseEvent) => {
    // Let the browser own anything that isn't a plain click, so ⌘-click and
    // middle-click still open a workspace in a new window.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    onOpen()
    // Clicking the tile focuses the <a>, and Radix Tooltip stays open while its
    // trigger is focused — so the name lingered after the pointer left until you
    // clicked elsewhere. Blur on a real mouse click (detail > 0) so the tooltip
    // closes with the pointer; keyboard activation (Enter, detail 0) keeps focus.
    if (e.detail > 0) (e.currentTarget as HTMLElement).blur()
  }

  const slot = index + 1
  const hint = slot <= 9 ? `⌘${slot}` : undefined
  const Icon = icon.Icon

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
        // `shrink-0` so a long list scrolls instead of squeezing the tiles: they
        // were being compressed to fit, which is the wrong thing to trade — an
        // icon is the whole identity here, and one squeezed to 17px is the
        // complaint this layout exists to answer. The fade mask on the scroller
        // says "more below" when they don't all fit.
        // No horizontal padding. It used to be `pl-1.5 pr-1`, meant to keep the
        // glyph off the active spine — but the spine is absolutely positioned and
        // never occupied flow space, so the asymmetry did nothing except push
        // every icon 1px right of the logo and the footer buttons, which centre in
        // the same column. A 22px icon in a 55px tile clears the spine by 14px on
        // its own.
        "group/tile relative flex h-10 w-full shrink-0 items-center rounded-md outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-accent focus-visible:ring-2",
        // Centred at 68px, a row at 232px. The indent for a filed workspace is
        // spent only in the wide state: at 68px the glyph *is* the identity, and
        // shifting it off the column's centre to imply nesting would cost more
        // than the nesting communicates — the group's header and its divider
        // already say where the members are.
        expanded
          ? cn("justify-start gap-2.5 pl-2 pr-1.5", nested && "pl-5")
          : "justify-center",
        isActive && "bg-sidebar-accent",
        drag?.isDragging && "opacity-40",
        // A rule above the drop position rather than shifting tiles under the
        // cursor — the rail's whole premise is that positions hold still.
        drag?.isDropTarget &&
          "before:absolute before:-top-px before:inset-x-1 before:h-0.5 before:rounded-full before:bg-sidebar-primary"
      )}
    >
      {/* The active spine sits in the same gutter the index reads from, so the
          eye tracks one column rather than two. */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-1 left-0 w-0.5 rounded-full transition-colors",
          isActive ? "bg-sidebar-primary" : "bg-transparent"
        )}
      />

      {/* Anchored to the tile's corner rather than to a glyph, which is what kept
          the previous badge from landing on top of the index digits. Running
          outranks unread: a working agent is the live fact, and a workspace can't
          be both waiting and arriving.

          Corner-anchored only while the tile is a square: in a row the same marks
          sit at the end of the line, in flow, so they can't land on the name. */}
      {expanded ? null : running ? (
        <span
          aria-hidden
          className="absolute right-1 top-1 size-1.5 animate-pulse rounded-full bg-primary"
        />
      ) : unreadCount > 0 ? (
        <span
          aria-hidden
          className="absolute right-0 top-0 min-w-3.5 rounded-full bg-sidebar-primary px-1 text-center text-[9px] font-medium leading-[14px] tabular-nums text-sidebar-primary-foreground"
        >
          {unreadCount > 9 ? "9+" : unreadCount}
        </span>
      ) : null}

      {/* The icon gets the whole tile: it used to share the height with a line of
          text below it, which is what held it to 17px.

          Weight carries the state, which is the thing a line icon can do and the
          emoji this replaced could not. Filled while active reads instantly at
          22px — a much clearer "you are here" than the tint or opacity shift that
          was standing in for it — and the outline recedes without ever becoming
          unrecognisable, which is the one thing this glyph must never be. */}
      <Icon
        aria-hidden
        className={cn(
          "size-[22px] shrink-0 transition-colors",
          isActive
            ? "text-sidebar-accent-foreground"
            : "text-sidebar-foreground/60 group-hover/tile:text-sidebar-foreground"
        )}
        weight={isActive ? "fill" : "regular"}
      />

      {expanded ? (
        <>
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-left text-[13px] leading-tight transition-colors",
              isActive
                ? "font-medium text-sidebar-accent-foreground"
                : "text-sidebar-foreground/80 group-hover/tile:text-sidebar-foreground"
            )}
          >
            {workspace.name}
          </span>

          {/* One slot at the end of the row, and status has first claim on it:
              the number is a hint you can also get from the tooltip, while a
              working agent or a waiting reply is the thing you widened the rail
              to see. */}
          {running ? (
            <span
              aria-hidden
              className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary"
            />
          ) : unreadCount > 0 ? (
            <span
              aria-hidden
              className="min-w-4 shrink-0 rounded-full bg-sidebar-primary px-1 text-center text-[10px] font-medium leading-4 tabular-nums text-sidebar-primary-foreground"
            >
              {unreadCount > 9 ? "9+" : unreadCount}
            </span>
          ) : (
            <span
              aria-hidden
              className={cn(
                "shrink-0 font-mono text-[10px] tabular-nums transition-colors",
                isActive
                  ? "text-sidebar-accent-foreground/70"
                  : "text-sidebar-foreground/30 group-hover/tile:text-sidebar-foreground/50"
              )}
            >
              {hint ?? String(slot).padStart(2, "0")}
            </span>
          )}
        </>
      ) : (
        /* Centred under the icon, not tucked into the left gutter. Hanging off
           one side put visual weight on the left of every tile, so the pair read
           as off-centre even once the icon itself was aligned — the glyph was
           correct and the block around it was not. Absolutely positioned, so it
           still costs the icon no height. */
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 text-center font-mono text-[9px] leading-[11px] tabular-nums tracking-tight transition-colors",
            isActive
              ? "font-medium text-sidebar-accent-foreground/80"
              : "text-sidebar-foreground/35 group-hover/tile:text-sidebar-foreground/60"
          )}
        >
          {String(slot).padStart(2, "0")}
        </span>
      )}
    </Link>
  )

  return (
    <Tooltip>
      <ContextMenu>
        <TooltipTrigger asChild>
          <ContextMenuTrigger asChild>{tile}</ContextMenuTrigger>
        </TooltipTrigger>
        <ContextMenuContent className="w-64">
          {/* The picker lives at the top of the menu the tile already had, so
              changing a face is a right-click away rather than a settings trip. A
              grid rather than menu rows: with the icon *being* the label, a list
              would be eighty rows of one glyph each. Capped in height and
              scrollable so a long set can grow without the menu running off the
              bottom of the screen. */}
          <div className="scrollbar-hover grid max-h-52 grid-cols-8 gap-0.5 overflow-y-auto p-1">
            {WORKSPACE_ICONS.map((choice) => {
              const ChoiceIcon = choice.Icon
              const selected = choice.key === icon.key
              return (
                // A menu item rather than a plain button, which is what these were
                // at first: a bare button inside the menu does not dismiss it, so
                // picking an icon left the menu sitting over the rail, covering the
                // one tile whose change you were trying to see. Menu items close on
                // select and join the menu's keyboard navigation.
                //
                // The overrides undo the row geometry `ContextMenuItem` assumes —
                // `px-2 py-1.5` and a 16px icon — because here the item *is* a grid
                // cell and the glyph is the whole label.
                <ContextMenuItem
                  key={choice.key}
                  onSelect={() => onSetIcon(choice.key)}
                  // The name carries the state: `aria-pressed` is not valid on a
                  // menuitem, so "current" goes in the label where a screen reader
                  // will actually reach it.
                  aria-label={selected ? `${choice.label} (current)` : choice.label}
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
          {/* Filing without dragging. Dragging is the fast path on a mouse, but
              it is the *only* path on a rail that also runs on a phone, where
              HTML5 drag events never fire — and it is an awkward gesture for a
              tile that is off-screen in a scrolled list either way. */}
          {onMoveToFolder && folders.length > 0 ? (
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

      {/* With no name on the tile this is where the name lives, so it carries the
          full thing plus the shortcut. Suppressed once the rail is labelled: a
          hover card repeating the name you can already read, over the column you
          are pointing at, is noise. */}
      <TooltipContent side="right" align="center" hidden={expanded}>
        {workspace.name}
        {hint ? (
          <span className="ml-2 font-mono text-muted-foreground">{hint}</span>
        ) : null}
      </TooltipContent>
    </Tooltip>
  )
}
