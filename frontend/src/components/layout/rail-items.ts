import {
  ChartBar,
  Clock,
  Cpu,
  Gear,
  SlidersHorizontal,
} from "@phosphor-icons/react"
import type { ComponentType } from "react"

export interface RailDestination {
  key: string
  label: string
  icon: ComponentType<{ className?: string }>
  to: string
}

/**
 * The whole-page destinations, which live behind the rail's ⋯ tile.
 *
 * These used to be tiles of their own — eight of them, stacked down the rail at
 * the same visual weight as the conversation list, two abbreviated past
 * legibility ("Sched", "Custom") and one truncated outright ("Activi…"). That
 * allocation was backwards: every one of these is a page you open, read and
 * leave, maybe once a session, while the workspaces you switch between dozens of
 * times a day had no representation in the rail at all. Labels that don't fit
 * their column are the symptom; the column was being spent on the wrong thing.
 *
 * So they collapse to one tile and a menu, where the labels finally fit, and the
 * rail's height goes to workspaces. ⌘K reaches all of them by name too.
 */
export const RAIL_DESTINATIONS: RailDestination[] = [
  { key: "schedules", label: "Schedules", icon: Clock, to: "/schedules" },
  { key: "usage", label: "Usage", icon: ChartBar, to: "/analytics" },
  { key: "laios", label: "LAIOS", icon: Cpu, to: "/laios" },
  {
    key: "customization",
    label: "Customization",
    icon: SlidersHorizontal,
    to: "/customization",
  },
  { key: "settings", label: "Settings", icon: Gear, to: "/settings" },
]

/**
 * Does this route match `to`? The root is exact — every path starts with "/",
 * so a prefix test there would swallow the whole app.
 */
export function matchesRoute(pathname: string, to: string): boolean {
  return to === "/"
    ? pathname === "/"
    : pathname === to || pathname.startsWith(`${to}/`)
}

/** True while one of the ⋯ destinations owns the main view. */
export function isDestinationRoute(pathname: string): boolean {
  return RAIL_DESTINATIONS.some((item) => matchesRoute(pathname, item.to))
}
