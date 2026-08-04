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
  RAIL_DESTINATIONS,
  matchesRoute,
} from "@/components/layout/rail-items"
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
 * left of `RAIL_DESTINATIONS` after Phase 2 took four of them into the settings
 * dialog: Usage, Video and Image, which are real pages rather than configuration.
 */
export function SessionsFooter({ onNavigate }: SessionsFooterProps) {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const githubConfig = useGitHubConfig().data
  const { openSettings } = useSettingsParam()

  const routeDestinations = RAIL_DESTINATIONS.filter(
    (item) => item.to !== undefined
  )
  const destinationActive = routeDestinations.some(
    (item) => item.to && matchesRoute(pathname, item.to)
  )

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
                  destinationActive &&
                    "bg-sidebar-accent text-sidebar-accent-foreground"
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
