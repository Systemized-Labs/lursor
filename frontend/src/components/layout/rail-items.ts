import {
  ChartBar,
  Clock,
  Cpu,
  FilmSlate,
  Gear,
  ImageSquare,
  SlidersHorizontal,
} from "@phosphor-icons/react"
import type { ComponentType } from "react"

export interface RailDestination {
  key: string
  label: string
  icon: ComponentType<{ className?: string }>
  /**
   * A whole-page route. Mutually exclusive with {@link settings}: a destination
   * is either somewhere you navigate to or a category of the settings dialog,
   * and the two behave differently everywhere they are consumed.
   */
  to?: string
  /**
   * Opens the settings dialog at this category (undefined category = its
   * default). Four former routes live here now — Settings, Customization, LAIOS
   * and Schedules — because the dialog opens *over* the page you are on instead
   * of replacing it, which is the whole point of it being a dialog.
   */
  settings?: { category?: string }
  /**
   * This destination also has its own tile in the rail footer.
   *
   * It stays in the menu — ⌘K and the ⋯ list should name every page — but the
   * ⋯ tile must not light up for it, or a route with a dedicated tile shows two
   * active controls at once and neither one tells you where you are.
   */
  pinned?: boolean
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
  {
    key: "schedules",
    label: "Schedules",
    icon: Clock,
    settings: { category: "schedules" },
  },
  { key: "usage", label: "Usage", icon: ChartBar, to: "/analytics" },
  { key: "laios", label: "LAIOS", icon: Cpu, settings: { category: "laios" } },
  { key: "video", label: "Video", icon: FilmSlate, to: "/video" },
  { key: "image", label: "Image", icon: ImageSquare, to: "/image" },
  {
    key: "customization",
    label: "Customization",
    icon: SlidersHorizontal,
    settings: { category: "capabilities" },
  },
  { key: "settings", label: "Settings", icon: Gear, settings: {}, pinned: true },
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

/**
 * The destination owning this route, if any.
 *
 * Also what names the route: the mobile header used to special-case
 * "/customization" and "/settings" and fall through to "New chat" for
 * everything else, so Video — and Schedules, Usage and LAIOS before it — sat
 * under a title for a page you weren't on. One list, one answer.
 *
 * Settings categories are never a match, deliberately: the dialog is over some
 * other route, and the header should keep naming the page underneath rather than
 * renaming it because a modal is open.
 */
export function destinationFor(pathname: string): RailDestination | undefined {
  return RAIL_DESTINATIONS.find(
    (item) => item.to !== undefined && matchesRoute(pathname, item.to)
  )
}

/**
 * True while the ⋯ tile is the rail's answer to "where am I".
 *
 * Pinned destinations are excluded: they have a tile of their own, and that tile
 * is the one carrying the active state.
 */
export function isDestinationRoute(pathname: string): boolean {
  const destination = destinationFor(pathname)
  return destination !== undefined && !destination.pinned
}
