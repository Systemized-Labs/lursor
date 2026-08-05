import { DotsThree, Gear, House, Palette } from "@phosphor-icons/react"
import { Link, useLocation, useNavigate } from "react-router-dom"

import { useGitHubConfig } from "@/api/github"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ThemePicker } from "@/components/ui/theme-picker"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  DESTINATIONS,
  isDestinationRoute,
  matchesRoute,
} from "@/components/layout/destinations"
import { useSettingsParam } from "@/components/settings/use-settings-param"
import { cn } from "@/lib/utils"

const TILE =
  "size-7 shrink-0 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"

interface SessionsFooterProps {
  onNavigate: () => void
}

/**
 * The pane's bottom row: home, the theme picker, the remaining destinations, and
 * settings wearing the GitHub identity when there is one.
 *
 * Small and horizontal because none of it is navigation you do while reading the
 * list — it is the stuff you reach for once and leave. The `⋯` menu holds what is
 * left of `DESTINATIONS` after Phase 2 took four of them into the settings
 * dialog: Usage, Video and Image, which are real pages rather than configuration.
 */
export function SessionsFooter({ onNavigate }: SessionsFooterProps) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const githubConfig = useGitHubConfig().data
  const { openSettings } = useSettingsParam()

  const routeDestinations = DESTINATIONS.filter(
    (item) => item.to !== undefined
  )
  const destinationActive = isDestinationRoute(pathname)

  return (
    <div className="flex shrink-0 items-center gap-1 border-t border-sidebar-border px-2 py-1.5">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" asChild className={TILE}>
            <Link
              to="/"
              onClick={onNavigate}
              aria-label="Home"
              aria-current={matchesRoute(pathname, "/") ? "page" : undefined}
            >
              <House className="size-4" />
            </Link>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Home</TooltipContent>
      </Tooltip>

      <ThemePicker
        trigger={(open) => (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={open}
                aria-label="Choose theme"
                className={TILE}
              >
                <Palette className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Choose theme</TooltipContent>
          </Tooltip>
        )}
      />

      <div className="min-w-0 flex-1" />

      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="More destinations"
                className={cn(
                  TILE,
                  // Radix puts `pointer-events: none` on the body while the menu
                  // is open, so `:hover` stops applying and the trigger would go
                  // flat the moment you click it. Hold the accent explicitly.
                  "data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground",
                  // "You are on one of these pages" is only a brighter icon. A
                  // filled tile is the active state for the *rows* above, where
                  // it reads as a highlighted line in a list; on a 28px square
                  // sitting between two flat tiles and a round avatar it reads
                  // as a stuck toggle instead, and it persists for as long as
                  // you stay on the page.
                  destinationActive && "text-sidebar-accent-foreground"
                )}
              >
                <DotsThree className="size-5" weight="bold" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">Usage, Video, Image…</TooltipContent>
        </Tooltip>
        <DropdownMenuContent side="top" align="end">
          {routeDestinations.map((item) => {
            const Icon = item.icon
            return (
              <DropdownMenuItem
                key={item.key}
                onSelect={() => {
                  if (item.to) navigate(item.to)
                  onNavigate()
                }}
                className={cn(
                  item.to && matchesRoute(pathname, item.to) && "font-medium"
                )}
              >
                <Icon className="size-4" />
                {item.label}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Settings, wearing the GitHub identity when there is one — the WindowBar
          has a ⚙ too, but this is the one carrying "signed in as". */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={TILE}
            aria-label="Settings"
            onClick={() => {
              openSettings()
              onNavigate()
            }}
          >
            {githubConfig?.avatar_url ? (
              <img
                src={githubConfig.avatar_url}
                alt=""
                className="size-6 rounded-full border border-sidebar-border object-cover"
              />
            ) : (
              <Gear className="size-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">
          {githubConfig?.login ? `Settings · @${githubConfig.login}` : "Settings"}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}
