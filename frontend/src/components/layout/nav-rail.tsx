import { Gear, Palette } from "@phosphor-icons/react"
import { Link, useLocation, useNavigate } from "react-router-dom"

import { useGitHubConfig } from "@/api/github"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ThemePicker } from "@/components/ui/theme-picker"
import { useSidebar } from "@/components/ui/sidebar"
import {
  RAIL_ITEMS,
  matchesRoute,
  railItemTo,
  type RailItem,
} from "@/components/layout/rail-items"
import type { PanelMode } from "@/components/layout/use-panel-mode"
import { isMacElectron } from "@/lib/platform"
import { cn } from "@/lib/utils"

/** Shared by the two footer tiles, which are icon buttons like any other. */
const FOOTER_TILE = "size-9 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"

interface NavRailProps {
  panelMode: PanelMode
  onPanelMode: (mode: PanelMode) => void
  /** False on the whole-page destinations, which collapse the panel away. */
  panelVisible: boolean
  studioId: string | undefined
  /** Conversations waiting on you, badged on Activity. */
  unreadCount: number
  onNavigate: () => void
}

/** How one tile should look and what a click on it does. */
interface TileState {
  to: string | undefined
  /** Owns the main view: an edge accent. */
  routeActive: boolean
  /** Owns the panel: a filled tile, Slack's selected treatment. */
  panelActive: boolean
  /** A second click puts the panel away. */
  collapses: boolean
}

/**
 * The 68px destination column, always visible — collapsing the sidebar hides the
 * panel and keeps this, which beats the old 3rem icon strip because labels stay
 * readable at this width.
 *
 * Destinations live here rather than workspaces because Lursor's ratio is the
 * inverse of Slack's: a handful of daily destinations against a dozen constantly
 * switched workspaces whose names (repos, often near-identical) are the only
 * reliable discriminator and need the panel's horizontal space.
 *
 * No new theme tokens: `index.css` carries 87 theme blocks, so a `--rail`
 * variable would be 87 edits and a standing obligation. Deriving the surface
 * from `--sidebar-accent` reads as a darker rail on dark themes and a lighter
 * inset on light ones, in all 87, for free.
 */
export function NavRail({
  panelMode,
  onPanelMode,
  panelVisible,
  studioId,
  unreadCount,
  onNavigate,
}: NavRailProps) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const githubConfig = useGitHubConfig().data
  // Every tile already carries its label; the tooltip only spells out the ones
  // abbreviated to fit 68px. On touch there is no hover, and a tooltip fired by
  // the post-tap focus would just cover the next tile.
  const { isMobile, setOpen } = useSidebar()

  /**
   * The whole active-state rule, in one place. An item with a `to` is active on
   * its route; an item without is active on its panel mode — so the two
   * indicators can never land on the same tile, and the tile that can look
   * filled is exactly the tile you can switch back off.
   */
  const tileState = (item: RailItem): TileState => {
    const to = railItemTo(item, studioId)
    const panelActive = panelVisible && !to && item.panel === panelMode
    return {
      to,
      routeActive: Boolean(to && matchesRoute(pathname, to)),
      panelActive,
      // Desktop only: the mobile panel is the whole drawer, and putting it away
      // would leave you looking at a bare rail you did not ask for.
      collapses: panelActive && !isMobile,
    }
  }

  return (
    <nav
      aria-label="Primary"
      // Collapsed *is* the rail, so both widths come from the one token rather
      // than a literal here and a constant in the sidebar primitive.
      className="flex w-(--sidebar-width-icon) shrink-0 flex-col border-r border-sidebar-border bg-sidebar-accent/40"
    >
      {/* On macOS the OS traffic lights overlay the top-left, which is now the
          rail — reserve a drag strip above the logo to clear them. */}
      <div
        className={cn(
          "flex shrink-0 flex-col items-center",
          isMacElectron && "[-webkit-app-region:drag]"
        )}
      >
        {isMacElectron ? <div className="h-8" /> : null}
        <Link
          to="/"
          onClick={onNavigate}
          aria-label="Lursor home"
          className="my-1.5 [-webkit-app-region:no-drag]"
        >
          <img
            src="/lursor_icon.png"
            alt="Lursor"
            className="size-9 rounded-md object-contain"
          />
        </Link>
      </div>

      <div className="scrollbar-hover flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1.5 py-1">
        {RAIL_ITEMS.map((item) => {
          const { to, routeActive, panelActive, collapses } = tileState(item)
          const Icon = item.icon
          const label = item.title ?? item.label
          const badge = item.key === "activity" ? unreadCount : 0
          return (
            <Tooltip key={item.key}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => {
                    if (collapses) setOpen(false)
                    else if (item.panel) onPanelMode(item.panel)
                    if (to) {
                      navigate(to)
                      onNavigate()
                    }
                  }}
                  aria-current={routeActive || panelActive ? "page" : undefined}
                  aria-expanded={to ? undefined : panelActive}
                  // Without this the badge joins the accessible name and the
                  // tile announces as "Activity 3" — a bare number saying
                  // nothing about what there are three of.
                  aria-label={badge ? `${label}, ${badge} unread` : undefined}
                  className={cn(
                    "relative flex w-full flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-sidebar-foreground/70 outline-none ring-sidebar-ring transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2",
                    panelActive &&
                      "bg-sidebar-accent text-sidebar-accent-foreground",
                    routeActive && "font-medium text-sidebar-foreground"
                  )}
                >
                  {routeActive ? (
                    <span
                      aria-hidden
                      className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-sidebar-primary"
                    />
                  ) : null}
                  <span className="relative">
                    <Icon className="size-5" />
                    {badge > 0 ? (
                      <span
                        aria-hidden
                        className="absolute -right-2 -top-1 min-w-4 rounded-full bg-sidebar-primary px-1 text-[10px] font-medium leading-4 tabular-nums text-sidebar-primary-foreground"
                      >
                        {badge > 9 ? "9+" : badge}
                      </span>
                    ) : null}
                  </span>
                  <span className="w-full truncate text-center text-[10px] leading-tight">
                    {item.label}
                  </span>
                </button>
              </TooltipTrigger>
              {/* Say so when the click would put the panel away — otherwise
                  the toggle is invisible until you trip over it. */}
              <TooltipContent side="right" align="center" hidden={isMobile}>
                {collapses ? `Hide ${label}` : label}
              </TooltipContent>
            </Tooltip>
          )
        })}
      </div>

      <div className="flex shrink-0 flex-col items-center gap-1 border-t border-sidebar-border py-2">
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

        {/* One Settings tile, wearing the GitHub identity when there is one.
            The old footer had both an avatar and a gear pointing at Settings
            because the avatar was the only target that survived collapsing; the
            rail never collapses, so one is enough. The tooltip carries the
            login, which no longer fits beside the tile. */}
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
