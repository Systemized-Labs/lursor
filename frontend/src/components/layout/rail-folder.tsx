import {
  CaretDown,
  CaretRight,
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { type WorkspaceIconDef } from "@/lib/workspace-icon"
import { cn } from "@/lib/utils"

interface RailFolderProps {
  folder: WorkspaceFolder
  /** Shut, so its members aren't drawn. */
  collapsed: boolean
  /** The rail is carrying names, so the header can be a labelled row. */
  expanded: boolean
  /** How many workspaces are filed here, shown while it's shut. */
  childCount: number
  /** An agent is working somewhere inside — rolled up from its members. */
  running: boolean
  /** Replies waiting inside, likewise. */
  unreadCount: number
  onToggle: () => void
  onRename: () => void
  onDelete: () => void
  /** Reordering the group itself, among the rail's root rows. */
  drag?: {
    onDragStart: (e: DragEvent) => void
    onDragOver: (e: DragEvent) => void
    onDrop: (e: DragEvent) => void
    onDragEnd: () => void
    isDragging: boolean
    /** A row is about to be inserted above this header. */
    isDropTarget: boolean
  }
  /** A workspace is hovering the header, about to be filed into this group. */
  isFileTarget?: boolean
  /** The member tiles, drawn by the rail. */
  children?: ReactNode
  /** Whether the mobile drawer is showing, which suppresses hover tooltips. */
  hideTooltip?: boolean
  /** Icons of the first few members, for the shut-folder 2×2 preview at 68px. */
  previewIcons?: WorkspaceIconDef[]
  /** The workspace you're in is filed here — rings the shut folder so the rail
   *  still says where you are even when the members aren't drawn. */
  containsActive?: boolean
}

/**
 * A group of workspaces in the rail: a header you can shut, and the tiles under
 * it.
 *
 * The group is drawn as a tint behind its rows rather than by indenting them.
 * Indentation is the obvious way to show nesting and the wrong one here: at 68px
 * the icon *is* the workspace's identity, and it is centred in the column on
 * purpose (see `workspace-tile.tsx` — half a pixel of lean was worth a comment),
 * so pushing members right would trade a legible glyph for a hierarchy cue that
 * a background already gives. Once the rail is labelled there is room for both,
 * and the tiles indent as well.
 *
 * Shutting a group is a per-device view preference, not part of the arrangement:
 * two people (or a laptop and a phone) can have the same filing open to
 * different depths, which is why it lives in localStorage while membership and
 * order live on the server.
 */
export function RailFolder({
  folder,
  collapsed,
  expanded,
  childCount,
  running,
  unreadCount,
  onToggle,
  onRename,
  onDelete,
  drag,
  isFileTarget = false,
  children,
  hideTooltip = false,
  previewIcons = [],
  containsActive = false,
}: RailFolderProps) {
  const Caret = collapsed ? CaretRight : CaretDown

  // The Discord move, at 68px: a shut folder is a 2×2 tile of the icons inside
  // it, and an open one is a folder glyph over its members, the whole thing
  // fenced in a pill. Once names are on (`expanded`) neither applies — the
  // labelled caret header carries the folder, shut or open.
  const isMini = collapsed && !expanded
  const isNarrowOpen = !collapsed && !expanded

  // While the group is open its members carry their own marks, so rolling them
  // up here as well would double-count what is already on screen. Shut, the
  // header is the only thing that can say something happened inside.
  const showRollup = collapsed && (running || unreadCount > 0)

  const header = (
    <button
      type="button"
      onClick={onToggle}
      draggable={Boolean(drag)}
      onDragStart={drag?.onDragStart}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
      onDragEnd={drag?.onDragEnd}
      aria-expanded={!collapsed}
      aria-label={`${folder.name}, ${childCount} workspace${
        childCount === 1 ? "" : "s"
      }`}
      className={cn(
        "group/folder relative flex w-full shrink-0 items-center rounded-md text-sidebar-foreground/55 outline-none ring-sidebar-ring transition-colors hover:text-sidebar-foreground focus-visible:ring-2",
        expanded ? "h-6 gap-1 px-1.5" : "h-5 justify-center gap-1",
        drag?.isDragging && "opacity-40",
        drag?.isDropTarget &&
          "before:absolute before:-top-px before:inset-x-1 before:h-0.5 before:rounded-full before:bg-sidebar-primary"
      )}
    >
      {expanded ? (
        <>
          <Caret aria-hidden weight="bold" className="size-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left text-[11px] font-medium uppercase tracking-wide">
            {folder.name}
          </span>
          {showRollup ? (
            running ? (
              <span
                aria-hidden
                className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary"
              />
            ) : (
              <span
                aria-hidden
                className="min-w-3.5 shrink-0 rounded-full bg-sidebar-primary px-1 text-center text-[9px] font-medium leading-[14px] tabular-nums text-sidebar-primary-foreground"
              >
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            )
          ) : collapsed ? (
            <span
              aria-hidden
              className="shrink-0 font-mono text-[9px] leading-none tabular-nums text-sidebar-foreground/35 group-hover/folder:text-sidebar-foreground/60"
            >
              {childCount}
            </span>
          ) : null}
        </>
      ) : (
        // Narrow and open: a folder glyph is the group's lid — clicking it shuts
        // the folder back to the 2×2 preview. The caret's job (which way does
        // this fold?) is already told by the members sitting under it in a pill.
        <FolderOpen
          aria-hidden
          weight="fill"
          className="size-[18px] shrink-0 text-sidebar-foreground/50 group-hover/folder:text-sidebar-foreground"
        />
      )}
    </button>
  )

  // The first four members' icons, laid out like a shut Discord folder. Fixed
  // 2×2 tracks so one or two members still read as a folder rather than a lone
  // tile — the empty cells hold their place as faint slots.
  const preview = previewIcons.slice(0, 4)
  const miniFolder = (
    <button
      type="button"
      onClick={onToggle}
      draggable={Boolean(drag)}
      onDragStart={drag?.onDragStart}
      onDragOver={drag?.onDragOver}
      onDrop={drag?.onDrop}
      onDragEnd={drag?.onDragEnd}
      aria-expanded={false}
      aria-label={`${folder.name}, ${childCount} workspace${
        childCount === 1 ? "" : "s"
      }`}
      className={cn(
        // Stacked, not overlaid: the count gets its own row under the grid so it
        // never lands on an icon. That makes the tile taller than a plain
        // workspace and pushes the rows below down a touch — the intended trade,
        // since a folder is more than one thing and earns a little more column.
        "group/folder relative flex w-full shrink-0 flex-col items-center gap-1 rounded-md py-1.5 outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-accent focus-visible:ring-2",
        drag?.isDragging && "opacity-40",
        drag?.isDropTarget &&
          "before:absolute before:-top-px before:inset-x-1 before:h-0.5 before:rounded-full before:bg-sidebar-primary"
      )}
    >
      <span className="relative">
        <span
          aria-hidden
          className={cn(
            "grid size-8 grid-cols-2 grid-rows-2 gap-px rounded-md bg-sidebar-accent/60 p-0.5 transition-colors group-hover/folder:bg-sidebar-accent",
            // The one bit of "where am I" a shut folder can still show: the group
            // holding the active workspace gets the same spine colour its tile
            // would have worn.
            containsActive && "ring-1 ring-sidebar-primary ring-inset"
          )}
        >
          {Array.from({ length: 4 }).map((_, i) => {
            const def = preview[i]
            if (!def) {
              return (
                <span
                  key={i}
                  className="rounded-[2px] bg-sidebar-foreground/[0.06]"
                />
              )
            }
            const Icon = def.Icon
            return (
              <Icon
                key={i}
                className="size-full text-sidebar-foreground/65"
                weight="regular"
              />
            )
          })}
        </span>

        {/* Status rolled up from the members, on the grid's corner — a working
            agent or waiting replies inside a folder you've shut. */}
        {running ? (
          <span
            aria-hidden
            className="absolute -right-1 -top-1 size-1.5 animate-pulse rounded-full bg-primary"
          />
        ) : unreadCount > 0 ? (
          <span
            aria-hidden
            className="absolute -right-1.5 -top-1.5 min-w-3.5 rounded-full bg-sidebar-primary px-1 text-center text-[9px] font-medium leading-[14px] tabular-nums text-sidebar-primary-foreground"
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        ) : null}
      </span>

      {/* How many are filed here, on its own row under the grid — bigger than a
          tile's slot number and clear of the icons, but the same mono face, so a
          shut folder still reads as part of the column. */}
      <span
        aria-hidden
        className="font-mono text-[11px] font-medium leading-none tabular-nums text-sidebar-foreground/45 group-hover/folder:text-sidebar-foreground/70"
      >
        {childCount}
      </span>
    </button>
  )

  const menu = (
    <ContextMenuContent className="w-56">
      <ContextMenuItem onSelect={onRename}>
        <Pencil className="size-4" />
        Rename folder
      </ContextMenuItem>
      {/* No `destructive` styling, because it isn't: the group goes, the
          workspaces come back to the top level. */}
      <ContextMenuItem onSelect={onDelete}>
        <Trash className="size-4" />
        Delete folder
      </ContextMenuItem>
    </ContextMenuContent>
  )

  return (
    <div
      data-folder={folder.id}
      className={cn(
        "flex shrink-0 flex-col transition-shadow",
        // Three skins for three states. Shut at 68px the folder *is* a single
        // tile, so it drops the group tint and padding entirely. Open at 68px it
        // becomes a pill — a rounded well the folder glyph and its members sit
        // in, so they read as one group without indentation. Labelled (wide) it
        // keeps the lighter square tint the section heading sits on.
        isMini
          ? "gap-0 rounded-md"
          : isNarrowOpen
            ? "gap-0.5 rounded-2xl bg-sidebar-accent/40 p-1 ring-1 ring-inset ring-sidebar-foreground/20"
            : "gap-0.5 rounded-md bg-sidebar-accent/30 p-0.5",
        // A ring around the whole group, not a line above a row: dropping onto
        // the header means "put it in here", and where inside is the group's
        // business, so the feedback has to name the container.
        isFileTarget && "ring-2 ring-sidebar-primary ring-inset"
      )}
    >
      <Tooltip>
        <ContextMenu>
          <TooltipTrigger asChild>
            <ContextMenuTrigger asChild>
              {isMini ? miniFolder : header}
            </ContextMenuTrigger>
          </TooltipTrigger>
          {menu}
        </ContextMenu>

        {/* At 68px the face is icons and a count, so the tooltip carries the
            name — the same trade the tiles make. */}
        <TooltipContent side="right" hidden={hideTooltip || expanded}>
          {folder.name}
          <span className="ml-2 text-muted-foreground">
            {childCount} workspace{childCount === 1 ? "" : "s"}
          </span>
        </TooltipContent>
      </Tooltip>

      {/* Shut at 68px the tile is the whole folder; its members aren't drawn
          (they're previewed in the grid), so there's nothing to render here. */}
      {isMini ? null : children}
    </div>
  )
}
