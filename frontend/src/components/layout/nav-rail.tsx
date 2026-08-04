import {
  Bell,
  CaretLeft,
  CaretRight,
  DotsThree,
  FolderPlus,
  Gear,
  Palette,
  Plus,
} from "@phosphor-icons/react"
import { useState, type DragEvent, type ReactNode } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"

// Imported rather than referenced as "/lursor_icon.png" out of public/: the
// packaged app loads index.html over file://, where a root-absolute URL points
// at the filesystem root and the image silently fails to load. Importing lets
// Vite emit a URL that honours `base` (see vite.config.ts).
import lursorIcon from "@/assets/lursor_icon.png"
import { useGitHubConfig } from "@/api/github"
import type { Workspace, WorkspaceFolder } from "@/api/types"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ThemePicker } from "@/components/ui/theme-picker"
import { useSidebar } from "@/components/ui/sidebar"
import {
  RAIL_DESTINATIONS,
  isDestinationRoute,
  matchesRoute,
} from "@/components/layout/rail-items"
import { RailFolder } from "@/components/layout/rail-folder"
import { WorkspaceTile } from "@/components/layout/workspace-tile"
import type { WorkspaceIcons } from "@/components/layout/use-workspace-icons"
import type { WorkspaceStatus } from "@/components/layout/use-workspace-status"
import type {
  RailDragged,
  RailDrop,
  WorkspaceTree,
} from "@/components/layout/use-workspace-tree"
import type { PanelMode } from "@/components/layout/use-panel-mode"
import { cn } from "@/lib/utils"

/** Shared by the footer tiles, which are icon buttons rather than labelled ones. */
const FOOTER_TILE =
  "size-9 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"

/** Do two drop targets name the same slot? */
function sameDrop(a: RailDrop | null, b: RailDrop): boolean {
  if (a === null || a.kind !== b.kind) return false
  if (a.kind === "root" && b.kind === "root") return a.index === b.index
  if (a.kind === "folder" && b.kind === "folder") {
    return a.folderId === b.folderId && a.index === b.index
  }
  return false
}

interface NavRailProps {
  /** The rail's rows — groups and workspaces — plus the moves that rearrange them. */
  tree: WorkspaceTree
  /** The Skill Studio, pinned below them; it is a workspace with an icon. */
  studio: Workspace | undefined
  activeWorkspaceId: string | undefined
  status: WorkspaceStatus
  icons: WorkspaceIcons
  hrefFor: (workspaceId: string) => string
  onOpenWorkspace: (workspaceId: string) => void
  panelMode: PanelMode
  onPanelMode: (mode: PanelMode) => void
  /** Whether the panel is showing, so the Activity tile can toggle it off. */
  panelVisible: boolean
  /** Conversations waiting on you anywhere, badged on Activity. */
  unreadCount: number
  onNavigate: () => void
  onNewWorkspace: () => void
  onNewFolder: () => void
  onRenameFolder: (folder: WorkspaceFolder) => void
  onDeleteFolder: (folder: WorkspaceFolder) => void
  onNewConversation: (workspaceId: string) => void
  onRenameWorkspace: (workspace: Workspace) => void
  onCloneWorkspace: (workspace: Workspace) => void
  onDeleteWorkspace: (workspace: Workspace) => void
}

/**
 * The workspace rail: your workspaces, the groups they're filed in, then the few
 * controls that aren't either.
 *
 * The rail holds workspaces because that is what gets switched. Reaching a
 * workspace used to mean expanding a folder in the panel and picking a
 * conversation out of it — and the panel is collapsed on half the app's routes,
 * so from a page like Usage there was no path back at all. Tiles are always on
 * screen, always in the same place, so returning is one click from anywhere and
 * ⌘1…⌘9 hit them without the mouse.
 *
 * Every tile also carries its own status, which is the part a switcher popover
 * could never do: agents keep working in the workspaces you aren't looking at,
 * and a rail you can see is a status board for them.
 *
 * It has two widths (⇧⌘B). At 68px a tile is a glyph and a slot number; at 232px
 * it is a labelled row. Both are the same list in the same order — widening adds
 * names, it doesn't rearrange anything — so the muscle memory survives the
 * toggle. Groups get the same treatment: a caret and a count when narrow, a
 * section heading when wide.
 *
 * No new theme tokens — `index.css` carries 87 theme blocks, so a `--rail`
 * variable would be 87 edits and a standing obligation. Deriving the surface
 * from `--sidebar-accent` reads as a darker rail on dark themes and a lighter
 * inset on light ones, in all 87, for free. For the same reason tiles are not
 * color-coded: a per-workspace hue would have to be an absolute color, and at
 * the handful of workspaces this rail is built for, the monogram and the tile's
 * position already tell them apart.
 */
export function NavRail({
  tree,
  studio,
  activeWorkspaceId,
  status,
  icons,
  hrefFor,
  onOpenWorkspace,
  panelMode,
  onPanelMode,
  panelVisible,
  unreadCount,
  onNavigate,
  onNewWorkspace,
  onNewFolder,
  onRenameFolder,
  onDeleteFolder,
  onNewConversation,
  onRenameWorkspace,
  onCloneWorkspace,
  onDeleteWorkspace,
}: NavRailProps) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const githubConfig = useGitHubConfig().data
  const { isMobile, setOpen, railExpanded, toggleRail } = useSidebar()

  // Drag-to-rearrange. Held here rather than per row so a row can tell whether
  // *it* is the current drop target — and, for a group, whether the drop means
  // "before me" or "into me".
  const [dragged, setDragged] = useState<RailDragged | null>(null)
  const [dropTarget, setDropTarget] = useState<RailDrop | null>(null)
  const [fileInto, setFileInto] = useState<string | null>(null)

  const endDrag = () => {
    setDragged(null)
    setDropTarget(null)
    setFileInto(null)
  }

  /** Drag handlers for a row that a drop would land *before*. */
  const rowDrag = (item: RailDragged, target: RailDrop) => {
    // Groups don't nest, so a slot inside one is not somewhere a group can go.
    // Refusing the dragover — rather than quietly redirecting the drop to the
    // group's own row — is what keeps the highlight honest: nothing lights up,
    // so nothing promised a landing spot it wasn't going to use.
    const rejects = dragged?.kind === "folder" && target.kind === "folder"
    return {
      onDragStart: (e: DragEvent) => {
        setDragged(item)
        e.dataTransfer.effectAllowed = "move"
        // Firefox ignores a drag with no payload; the row itself is carried in
        // component state, so the data is a formality.
        e.dataTransfer.setData("text/plain", item.id)
      },
      onDragOver: (e: DragEvent) => {
        if (!dragged || rejects) return
        e.preventDefault()
        setDropTarget(target)
        setFileInto(null)
      },
      onDrop: (e: DragEvent) => {
        e.preventDefault()
        if (!rejects && dragged && dragged.id !== item.id) {
          tree.move(dragged, target)
        }
        endDrag()
      },
      onDragEnd: endDrag,
      isDragging: dragged?.id === item.id,
      isDropTarget:
        !rejects && sameDrop(dropTarget, target) && dragged?.id !== item.id,
    }
  }

  const activeDrag = dragged !== null

  const folderTargets = tree.folders.map((folder) => ({
    id: folder.id,
    name: folder.name,
  }))

  // Activity owns the panel rather than a route, so its tile is filled while the
  // panel is showing it — and a second click puts the panel away. Desktop only:
  // on mobile the panel *is* the drawer, and closing it would leave you looking
  // at a bare rail you did not ask for.
  const activityActive = panelVisible && panelMode === "activity"
  const activityCollapses = activityActive && !isMobile

  // Setting the mode is not enough when the panel is away: with the sidebar
  // collapsed there is nothing rendering that mode, so the click looked inert —
  // the one control whose entire job is the panel could not bring it back.
  const showActivity = () => {
    onPanelMode("activity")
    if (!panelVisible) setOpen(true)
  }

  // A workspace tile governs the panel on the same terms: it shows that
  // workspace's conversations, bringing the panel back if it is away, and
  // clicking the workspace already showing there puts it away again. Switching
  // *to* a workspace and toggling the list for the one you are in are the same
  // gesture because they are the same intent — "show me this workspace" — and
  // the tile is the only control the collapsed rail has for it.
  const showsChatsFor = (workspaceId: string) =>
    panelVisible && panelMode === "chats" && activeWorkspaceId === workspaceId

  const openTile = (workspaceId: string) => {
    // Mobile's panel is the drawer; collapsing it would leave a bare rail.
    if (showsChatsFor(workspaceId) && !isMobile) {
      setOpen(false)
      return
    }
    if (!panelVisible) setOpen(true)
    onOpenWorkspace(workspaceId)
  }

  const destinationActive = isDestinationRoute(pathname)

  /** One member or loose workspace, with everything both widths need. */
  const tile = (
    workspace: Workspace,
    slot: number,
    target: RailDrop,
    nested: boolean
  ) => {
    const { running, unread } = status(workspace.id)
    return (
      <WorkspaceTile
        key={workspace.id}
        workspace={workspace}
        index={slot - 1}
        href={hrefFor(workspace.id)}
        icon={icons.iconFor(workspace)}
        hasIconOverride={icons.hasOverride(workspace.id)}
        isActive={activeWorkspaceId === workspace.id}
        running={running}
        unreadCount={unread}
        expanded={railExpanded && !isMobile}
        nested={nested}
        folders={folderTargets}
        onMoveToFolder={(folderId) => tree.moveToFolder(workspace.id, folderId)}
        onOpen={() => openTile(workspace.id)}
        onSetIcon={(next) => icons.setIcon(workspace.id, next)}
        onNewConversation={() => onNewConversation(workspace.id)}
        onRename={() => onRenameWorkspace(workspace)}
        onClone={() => onCloneWorkspace(workspace)}
        onDelete={() => onDeleteWorkspace(workspace)}
        drag={rowDrag({ kind: "workspace", id: workspace.id }, target)}
      />
    )
  }

  return (
    <nav
      aria-label="Primary"
      // Collapsed *is* the rail, so both widths come from the one token rather
      // than a literal here and a constant in the sidebar primitive.
      //
      // The separator is an `after:` pseudo-element rather than `border-r`, which
      // is not cosmetic pedantry: a real border is inside the box, so it made the
      // content column 67px of a 68px rail and centred every icon half a pixel
      // left of the rail's visible middle. On a 2× display that is a whole device
      // pixel of consistent leftward lean. Out of flow, the column is the full
      // 68px and its centre is the rail's centre.
      className="relative flex w-(--sidebar-width-icon) shrink-0 flex-col bg-sidebar-accent/40 transition-[width] duration-200 ease-linear after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-sidebar-border after:content-['']"
    >
      {/* The macOS traffic lights are cleared by the one chrome strip above both
          columns (see AppSidebar), not by a reservation here — a strip inside the
          rail put the separator and the rail's tint through the buttons. */}
      <div className="flex shrink-0 flex-col items-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              to="/"
              onClick={onNavigate}
              aria-label="New chat"
              aria-current={matchesRoute(pathname, "/") ? "page" : undefined}
              className={cn(
                "my-1.5 flex items-center rounded-md outline-none ring-sidebar-ring focus-visible:ring-2",
                railExpanded && !isMobile ? "mx-1.5 gap-2 self-stretch px-1" : ""
              )}
            >
              <img
                src={lursorIcon}
                alt="Lursor"
                className="size-9 shrink-0 rounded-md object-contain"
              />
              {railExpanded && !isMobile ? (
                <span className="truncate text-[13px] font-medium text-sidebar-foreground/80">
                  New chat
                </span>
              ) : null}
            </Link>
          </TooltipTrigger>
          <TooltipContent
            side="right"
            hidden={isMobile || (railExpanded && !isMobile)}
          >
            New chat
          </TooltipContent>
        </Tooltip>
      </div>

      {/* A mask, not a plain clip. With a dozen workspaces the list overflows,
          and a tile sliced flat by the footer border reads as a rendering fault
          rather than as more content — the fade says "scroll" without spending a
          row on a chevron. `mask-image` degrades to no mask where unsupported,
          which is exactly today's behaviour. */}
      {/* `no-scrollbar`, not `scrollbar-hover`. The reveal-on-hover variant only
          makes the *thumb* transparent — the global `::-webkit-scrollbar` is 10px
          wide, so an overflowing rail still reserved that gutter and centred its
          icons in 58px of a 68px column: a 5px leftward shift, appearing only once
          there were enough workspaces to overflow, while the footer buttons (not
          in a scroll container) stayed put. A 68px icon column has no room to
          spend on a bar nobody needs, and the fade mask below already says there
          is more. */}
      <div className="no-scrollbar flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1.5 py-1 [mask-image:linear-gradient(to_bottom,transparent,black_10px,black_calc(100%-14px),transparent)]">
        {tree.nodes.map((node, rootIndex) => {
          if (node.kind === "workspace") {
            return tile(
              node.workspace,
              node.slot,
              { kind: "root", index: rootIndex },
              false
            )
          }

          const { folder, children, collapsed } = node
          // A shut group still shows the workspace you are *in*: the rail's job
          // is to say where you are, and a tile that disappears because you
          // tidied it away would take that answer with it.
          const visible = collapsed
            ? children.filter((c) => c.workspace.id === activeWorkspaceId)
            : children
          const rollup = children.reduce(
            (acc, { workspace }) => {
              const { running, unread } = status(workspace.id)
              return {
                running: acc.running || running,
                unread: acc.unread + unread,
              }
            },
            { running: false, unread: 0 }
          )

          return (
            <RailFolder
              key={folder.id}
              folder={folder}
              collapsed={collapsed}
              expanded={railExpanded && !isMobile}
              childCount={children.length}
              previewIcons={children
                .slice(0, 4)
                .map((c) => icons.iconFor(c.workspace))}
              containsActive={children.some(
                (c) => c.workspace.id === activeWorkspaceId
              )}
              running={rollup.running}
              unreadCount={rollup.unread}
              hideTooltip={isMobile}
              onToggle={() => tree.toggleFolder(folder.id)}
              onRename={() => onRenameFolder(folder)}
              onDelete={() => onDeleteFolder(folder)}
              isFileTarget={fileInto === folder.id}
              drag={{
                ...rowDrag({ kind: "folder", id: folder.id }, {
                  kind: "root",
                  index: rootIndex,
                }),
                // A workspace dropped on the header goes *inside*; only another
                // group reorders against it. Same gesture, different meaning,
                // decided by what is in your hand.
                onDragOver: (e: DragEvent) => {
                  if (!dragged) return
                  e.preventDefault()
                  if (dragged.kind === "workspace") {
                    setFileInto(folder.id)
                    setDropTarget(null)
                  } else {
                    setDropTarget({ kind: "root", index: rootIndex })
                    setFileInto(null)
                  }
                },
                onDrop: (e: DragEvent) => {
                  e.preventDefault()
                  if (dragged?.kind === "workspace") {
                    tree.move(dragged, {
                      kind: "folder",
                      folderId: folder.id,
                      index: children.length,
                    })
                  } else if (dragged && dragged.id !== folder.id) {
                    tree.move(dragged, { kind: "root", index: rootIndex })
                  }
                  endDrag()
                },
              }}
            >
              {visible.map(({ workspace, slot }) =>
                tile(
                  workspace,
                  slot,
                  {
                    kind: "folder",
                    folderId: folder.id,
                    index: children.findIndex(
                      (c) => c.workspace.id === workspace.id
                    ),
                  },
                  true
                )
              )}
              {/* An open group needs a floor to drop onto, or its last slot is
                  unreachable: every row above hands you the space *before* it. */}
              {activeDrag && !collapsed && dragged?.kind === "workspace" ? (
                <DropFloor
                  active={sameDrop(dropTarget, {
                    kind: "folder",
                    folderId: folder.id,
                    index: children.length,
                  })}
                  onOver={() => {
                    setDropTarget({
                      kind: "folder",
                      folderId: folder.id,
                      index: children.length,
                    })
                    setFileInto(null)
                  }}
                  onDrop={() => {
                    if (dragged) {
                      tree.move(dragged, {
                        kind: "folder",
                        folderId: folder.id,
                        index: children.length,
                      })
                    }
                    endDrag()
                  }}
                />
              ) : null}
            </RailFolder>
          )
        })}

        {/* The same floor for the top level, which is also how a workspace gets
            back out of a group when every root row is above it. */}
        {activeDrag ? (
          <DropFloor
            active={sameDrop(dropTarget, {
              kind: "root",
              index: tree.nodes.length,
            })}
            onOver={() => {
              setDropTarget({ kind: "root", index: tree.nodes.length })
              setFileInto(null)
            }}
            onDrop={() => {
              if (dragged) {
                tree.move(dragged, { kind: "root", index: tree.nodes.length })
              }
              endDrag()
            }}
          />
        ) : null}

        {/* The studio is app-owned and can't be deleted, reordered or filed, so
            it sits below the ones that can, behind a divider. It is a real
            workspace, and being a tile here is what let the old "Skills"
            destination — a nav row that was secretly a workspace, with its own
            panel mode — go away. */}
        {studio ? (
          <>
            <span
              aria-hidden
              className="mx-2 my-1 h-px shrink-0 bg-sidebar-border"
            />
            <WorkspaceTile
              key={studio.id}
              workspace={studio}
              index={tree.ordered.length}
              href={hrefFor(studio.id)}
              icon={icons.iconFor(studio)}
              hasIconOverride={icons.hasOverride(studio.id)}
              isActive={activeWorkspaceId === studio.id}
              running={status(studio.id).running}
              unreadCount={status(studio.id).unread}
              expanded={railExpanded && !isMobile}
              onOpen={() => openTile(studio.id)}
              onSetIcon={(next) => icons.setIcon(studio.id, next)}
              onNewConversation={() => onNewConversation(studio.id)}
              onRename={() => onRenameWorkspace(studio)}
              onClone={() => onCloneWorkspace(studio)}
              onDelete={() => onDeleteWorkspace(studio)}
            />
          </>
        ) : null}

        <div className="mt-0.5 flex shrink-0 flex-col gap-0.5">
          <RailAction
            label="New workspace"
            icon={<Plus className="size-[17px]" />}
            expanded={railExpanded && !isMobile}
            hideTooltip={isMobile}
            onClick={onNewWorkspace}
          />
          <RailAction
            label="New folder"
            icon={<FolderPlus className="size-[17px]" />}
            expanded={railExpanded && !isMobile}
            hideTooltip={isMobile}
            onClick={onNewFolder}
          />
        </div>
      </div>

      <div
        className={cn(
          "flex shrink-0 border-t border-sidebar-border py-2",
          // The controls stack in a 68px column and wrap to two rows at 232px,
          // which is the point of the extra width: spending a row apiece on them
          // in a labelled rail would push the workspaces off the screen.
          railExpanded && !isMobile
            ? "flex-row flex-wrap items-center justify-center gap-1 px-1.5"
            : "flex-col items-center gap-1"
        )}
      >
        {/* Cross-workspace attention. The per-tile marks say *where* something
            happened; this is the list of what. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                if (activityCollapses) setOpen(false)
                else showActivity()
              }}
              aria-expanded={activityActive}
              aria-label={
                unreadCount ? `Activity, ${unreadCount} unread` : "Activity"
              }
              className={cn(
                FOOTER_TILE,
                "relative",
                activityActive &&
                  "bg-sidebar-accent text-sidebar-accent-foreground"
              )}
            >
              <Bell className="size-5" />
              {unreadCount > 0 ? (
                <span
                  aria-hidden
                  className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-sidebar-primary px-1 text-[10px] font-medium leading-4 tabular-nums text-sidebar-primary-foreground"
                >
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              ) : null}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right" hidden={isMobile}>
            {activityCollapses ? "Hide Activity" : "Activity"}
          </TooltipContent>
        </Tooltip>

        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="More destinations"
                  className={cn(
                    FOOTER_TILE,
                    destinationActive &&
                      "bg-sidebar-accent text-sidebar-accent-foreground"
                  )}
                >
                  <DotsThree className="size-5" weight="bold" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="right" hidden={isMobile}>
              Schedules, Usage, LAIOS…
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent side="right" align="end">
            {RAIL_DESTINATIONS.map((item) => {
              const Icon = item.icon
              return (
                <DropdownMenuItem
                  key={item.key}
                  onSelect={() => {
                    navigate(item.to)
                    onNavigate()
                  }}
                  className={cn(
                    matchesRoute(pathname, item.to) && "font-medium"
                  )}
                >
                  <Icon className="size-4" />
                  {item.label}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        <ThemePicker
          trigger={(open) => (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={open}
                  aria-label="Choose theme"
                  className={FOOTER_TILE}
                >
                  <Palette className="size-5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right" hidden={isMobile}>
                Choose theme
              </TooltipContent>
            </Tooltip>
          )}
        />

        {/* Settings, wearing the GitHub identity when there is one. Also in the
            ⋯ menu above; this is the one you aim at without reading. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" asChild className={FOOTER_TILE}>
              <Link to="/settings" onClick={onNavigate} aria-label="Settings">
                {githubConfig?.avatar_url ? (
                  <img
                    src={githubConfig.avatar_url}
                    alt=""
                    className="size-7 rounded-full border border-sidebar-border object-cover"
                  />
                ) : (
                  <Gear className="size-5" />
                )}
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right" hidden={isMobile}>
            {githubConfig?.login
              ? `Settings · @${githubConfig.login}`
              : "Settings"}
          </TooltipContent>
        </Tooltip>
      </div>

      {/* The width toggle, moved onto the rail's own edge — a collapse handle
          where the eye already is when it wants more or less rail, rather than a
          glyph buried in the footer. Straddles the separator and points the way
          it will move: ‹ shrinks back to icons, › reveals names. Desktop only;
          the mobile drawer has no width to trade. */}
      {isMobile ? null : (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggleRail}
              aria-expanded={railExpanded}
              aria-label={
                railExpanded ? "Show icons only" : "Show workspace names"
              }
              className="absolute right-0 top-1/2 z-30 flex h-8 w-4 -translate-y-1/2 translate-x-1/2 items-center justify-center rounded-md border border-sidebar-border bg-sidebar text-sidebar-foreground/60 shadow-sm outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2"
            >
              {railExpanded ? (
                <CaretLeft weight="bold" className="size-3" />
              ) : (
                <CaretRight weight="bold" className="size-3" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">
            {railExpanded ? "Show icons only" : "Show workspace names"}
            <span className="ml-2 font-mono text-muted-foreground">⇧⌘B</span>
          </TooltipContent>
        </Tooltip>
      )}
    </nav>
  )
}

/**
 * The strip of empty space at the end of a list that makes its last slot
 * reachable. Only rendered mid-drag: a permanent gap would be dead space in a
 * column this narrow, and an invisible drop zone under the tiles would swallow
 * clicks meant for them.
 */
function DropFloor({
  active,
  onOver,
  onDrop,
}: {
  active: boolean
  onOver: () => void
  onDrop: () => void
}) {
  return (
    <div
      aria-hidden
      onDragOver={(e) => {
        e.preventDefault()
        onOver()
      }}
      onDrop={(e) => {
        e.preventDefault()
        onDrop()
      }}
      className={cn(
        "h-3 shrink-0 rounded",
        active && "bg-sidebar-primary/20 ring-1 ring-sidebar-primary ring-inset"
      )}
    />
  )
}

/** "New workspace" / "New folder": an icon button narrow, a labelled row wide. */
function RailAction({
  label,
  icon,
  expanded,
  hideTooltip,
  onClick,
}: {
  label: string
  icon: ReactNode
  expanded: boolean
  hideTooltip: boolean
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          className={cn(
            "flex h-9 w-full shrink-0 items-center rounded-md text-sidebar-foreground/40 outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2",
            expanded ? "gap-2.5 px-2" : "justify-center"
          )}
        >
          <span className="flex size-[22px] shrink-0 items-center justify-center">
            {icon}
          </span>
          {expanded ? (
            <span className="truncate text-[13px]">{label}</span>
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" hidden={hideTooltip || expanded}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
