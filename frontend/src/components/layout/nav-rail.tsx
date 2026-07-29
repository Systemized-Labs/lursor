import { Bell, DotsThree, FolderPlus, Gear, Palette } from "@phosphor-icons/react"
import { useState, type DragEvent } from "react"
import { Link, useLocation, useNavigate } from "react-router-dom"

import { useGitHubConfig } from "@/api/github"
import type { Workspace } from "@/api/types"
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
import { WorkspaceTile } from "@/components/layout/workspace-tile"
import type { WorkspaceIcons } from "@/components/layout/use-workspace-icons"
import type { WorkspaceStatus } from "@/components/layout/use-workspace-status"
import type { PanelMode } from "@/components/layout/use-panel-mode"
import { isMacElectron } from "@/lib/platform"
import { cn } from "@/lib/utils"

/** Shared by the footer tiles, which are icon buttons rather than labelled ones. */
const FOOTER_TILE =
  "size-9 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"

interface NavRailProps {
  /** User workspaces in rail order — the tiles ⌘1…⌘9 address. */
  workspaces: Workspace[]
  /** The Skill Studio, pinned below them; it is a workspace with an icon. */
  studio: Workspace | undefined
  activeWorkspaceId: string | undefined
  status: WorkspaceStatus
  icons: WorkspaceIcons
  hrefFor: (workspaceId: string) => string
  onOpenWorkspace: (workspaceId: string) => void
  onReorder: (from: number, to: number) => void
  panelMode: PanelMode
  onPanelMode: (mode: PanelMode) => void
  /** Whether the panel is showing, so the Activity tile can toggle it off. */
  panelVisible: boolean
  /** Conversations waiting on you anywhere, badged on Activity. */
  unreadCount: number
  onNavigate: () => void
  onNewWorkspace: () => void
  onNewConversation: (workspaceId: string) => void
  onRenameWorkspace: (workspace: Workspace) => void
  onCloneWorkspace: (workspace: Workspace) => void
  onDeleteWorkspace: (workspace: Workspace) => void
}

/**
 * The 68px rail: your workspaces, then the few controls that aren't one.
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
 * No new theme tokens — `index.css` carries 87 theme blocks, so a `--rail`
 * variable would be 87 edits and a standing obligation. Deriving the surface
 * from `--sidebar-accent` reads as a darker rail on dark themes and a lighter
 * inset on light ones, in all 87, for free. For the same reason tiles are not
 * color-coded: a per-workspace hue would have to be an absolute color, and at
 * the handful of workspaces this rail is built for, the monogram and the tile's
 * position already tell them apart.
 */
export function NavRail({
  workspaces,
  studio,
  activeWorkspaceId,
  status,
  icons,
  hrefFor,
  onOpenWorkspace,
  onReorder,
  panelMode,
  onPanelMode,
  panelVisible,
  unreadCount,
  onNavigate,
  onNewWorkspace,
  onNewConversation,
  onRenameWorkspace,
  onCloneWorkspace,
  onDeleteWorkspace,
}: NavRailProps) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const githubConfig = useGitHubConfig().data
  const { isMobile, setOpen } = useSidebar()

  // Drag-to-reorder. Held here rather than per tile so a tile can tell whether
  // *it* is the current drop target.
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)

  const dragFor = (index: number) => ({
    onDragStart: (e: DragEvent) => {
      setDragIndex(index)
      e.dataTransfer.effectAllowed = "move"
      // Firefox ignores a drag with no payload; the index itself is carried in
      // component state, so the data is a formality.
      e.dataTransfer.setData("text/plain", String(index))
    },
    onDragOver: (e: DragEvent) => {
      if (dragIndex === null) return
      e.preventDefault()
      setOverIndex(index)
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      if (dragIndex !== null) onReorder(dragIndex, index)
      setDragIndex(null)
      setOverIndex(null)
    },
    onDragEnd: () => {
      setDragIndex(null)
      setOverIndex(null)
    },
    isDragging: dragIndex === index,
    isDropTarget: overIndex === index && dragIndex !== index,
  })

  // Activity owns the panel rather than a route, so its tile is filled while the
  // panel is showing it — and a second click puts the panel away. Desktop only:
  // on mobile the panel *is* the drawer, and closing it would leave you looking
  // at a bare rail you did not ask for.
  const activityActive = panelVisible && panelMode === "activity"
  const activityCollapses = activityActive && !isMobile

  const destinationActive = isDestinationRoute(pathname)

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
      className="relative flex w-(--sidebar-width-icon) shrink-0 flex-col bg-sidebar-accent/40 after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-sidebar-border after:content-['']"
    >
      {/* On macOS the OS traffic lights overlay the top-left, which is the rail —
          reserve a drag strip above the logo to clear them. */}
      <div
        className={cn(
          "flex shrink-0 flex-col items-center",
          isMacElectron && "[-webkit-app-region:drag]"
        )}
      >
        {isMacElectron ? <div className="h-8" /> : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              to="/"
              onClick={onNavigate}
              aria-label="New chat"
              aria-current={matchesRoute(pathname, "/") ? "page" : undefined}
              className="my-1.5 rounded-md outline-none ring-sidebar-ring focus-visible:ring-2 [-webkit-app-region:no-drag]"
            >
              <img
                src="/lursor_icon.png"
                alt="Lursor"
                className="size-9 rounded-md object-contain"
              />
            </Link>
          </TooltipTrigger>
          <TooltipContent side="right" hidden={isMobile}>
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
      <div
        className="no-scrollbar flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1.5 py-1 [mask-image:linear-gradient(to_bottom,transparent,black_10px,black_calc(100%-14px),transparent)]"
      >
        {workspaces.map((ws, index) => {
          const { running, unread } = status(ws.id)
          return (
            <WorkspaceTile
              key={ws.id}
              workspace={ws}
              index={index}
              href={hrefFor(ws.id)}
              icon={icons.iconFor(ws)}
              hasIconOverride={icons.hasOverride(ws.id)}
              isActive={activeWorkspaceId === ws.id}
              running={running}
              unreadCount={unread}
              onOpen={() => onOpenWorkspace(ws.id)}
              onSetIcon={(next) => icons.setIcon(ws.id, next)}
              onNewConversation={() => onNewConversation(ws.id)}
              onRename={() => onRenameWorkspace(ws)}
              onClone={() => onCloneWorkspace(ws)}
              onDelete={() => onDeleteWorkspace(ws)}
              drag={dragFor(index)}
            />
          )
        })}

        {/* The studio is app-owned and can't be deleted or reordered, so it sits
            below the ones that can, behind a divider. It is a real workspace, and
            being a tile here is what let the old "Skills" destination — a nav row
            that was secretly a workspace, with its own panel mode — go away. */}
        {studio ? (
          <>
            <span
              aria-hidden
              className="mx-2 my-1 h-px shrink-0 bg-sidebar-border"
            />
            <WorkspaceTile
              key={studio.id}
              workspace={studio}
              index={workspaces.length}
              href={hrefFor(studio.id)}
              icon={icons.iconFor(studio)}
              hasIconOverride={icons.hasOverride(studio.id)}
              isActive={activeWorkspaceId === studio.id}
              running={status(studio.id).running}
              unreadCount={status(studio.id).unread}
              onOpen={() => onOpenWorkspace(studio.id)}
              onSetIcon={(next) => icons.setIcon(studio.id, next)}
              onNewConversation={() => onNewConversation(studio.id)}
              onRename={() => onRenameWorkspace(studio)}
              onClone={() => onCloneWorkspace(studio)}
              onDelete={() => onDeleteWorkspace(studio)}
            />
          </>
        ) : null}

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onNewWorkspace}
              aria-label="New workspace"
              className="mt-0.5 flex h-10 w-full shrink-0 items-center justify-center rounded-md text-sidebar-foreground/40 outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2"
            >
              <FolderPlus className="size-[17px]" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" hidden={isMobile}>
            New workspace
          </TooltipContent>
        </Tooltip>
      </div>

      <div className="flex shrink-0 flex-col items-center gap-1 border-t border-sidebar-border py-2">
        {/* Cross-workspace attention. The per-tile marks say *where* something
            happened; this is the list of what. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                if (activityCollapses) setOpen(false)
                else onPanelMode("activity")
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
    </nav>
  )
}
