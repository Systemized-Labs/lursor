import {
  ChartBar,
  Clock,
  Cpu,
  FilmSlate,
  Gear,
  ImageSquare,
  SlidersHorizontal,
  Stack,
} from "@phosphor-icons/react"
import type { ComponentType } from "react"

export interface Destination {
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
 * The destinations behind the sidebar footer's ⋯ menu.
 *
 * Two kinds now, and neither is what this list started as. Four of them open the
 * settings dialog over wherever you are (Schedules, LAIOS, Customization,
 * Settings); the rest are `to` paths that the shell answers with a *pane* rather
 * than a page — see `PANE_ROUTES` in the shell. So a "destination" is a name and an
 * intent, and what happens when you pick one is decided elsewhere.
 *
 * They were tiles down the nav rail once, eight of them, two abbreviated past
 * legibility ("Sched", "Custom") and one truncated outright ("Activi…"). ⌘K reaches
 * all of them by name too.
 */
export const DESTINATIONS: Destination[] = [
  {
    key: "schedules",
    label: "Schedules",
    icon: Clock,
    settings: { category: "schedules" },
  },
  { key: "usage", label: "Usage", icon: ChartBar, to: "/analytics" },
  { key: "artifacts", label: "Artifacts", icon: Stack, to: "/artifacts" },
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
export function destinationFor(pathname: string): Destination | undefined {
  return DESTINATIONS.find(
    (item) => item.to !== undefined && matchesRoute(pathname, item.to)
  )
}

/**
 * True while the ⋯ menu is the footer's answer to "where am I".
 *
 * Pinned destinations are excluded: they have a control of their own, and that one
 * carries the active state.
 */
export function isDestinationRoute(pathname: string): boolean {
  const destination = destinationFor(pathname)
  return destination !== undefined && !destination.pinned
}
