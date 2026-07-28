import {
  Bell,
  ChartBar,
  ChatsCircle,
  Clock,
  Cpu,
  NotePencil,
  SlidersHorizontal,
  Sparkle,
} from "@phosphor-icons/react"
import type { ComponentType } from "react"

import type { PanelMode } from "@/components/layout/use-panel-mode"

export interface RailItem {
  key: string
  label: string
  /** Spelled out in the tooltip when the 10px label had to be abbreviated. */
  title?: string
  icon: ComponentType<{ className?: string }>
  /** Where a click travels, if anywhere. */
  to?: string
  /**
   * The Skill Studio is a real workspace, so its route isn't known until the
   * workspace list loads. Declared as a flag rather than resolved by key at the
   * render site, so "which item is the studio" stays in this table.
   */
  studioRoute?: true
  /** Which list a click puts in the panel, if any. */
  panel?: PanelMode
}

/**
 * The rail, top to bottom. Each item declares up to two effects — navigate,
 * and/or swap the panel — and that is the whole contract. A click does both if
 * both are set.
 *
 * An item with a `to` and no `panel` is a **whole-page destination**: it owns
 * the window, so arriving there collapses the panel. That is one fact, declared
 * once, here — {@link routeHasPanel} derives from this table rather than
 * repeating the route strings, because two lists that must agree eventually
 * won't, and the failure mode is a stale conversation list beside a dashboard.
 *
 * Module-level rather than built per render: only the studio's `to` is dynamic,
 * and that resolves at the one item that needs it.
 */
export const RAIL_ITEMS: RailItem[] = [
  // No `panel`: the New Agent home is a whole-page destination, so declaring
  // one would open the panel and let the route rule shut it again a frame
  // later — a flash through the width transition, for nothing.
  { key: "new", label: "New", title: "New Chat", icon: NotePencil, to: "/" },
  { key: "chats", label: "Chats", icon: ChatsCircle, panel: "chats" },
  { key: "activity", label: "Activity", icon: Bell, panel: "activity" },
  {
    key: "skills",
    label: "Skills",
    title: "Skill Studio",
    icon: Sparkle,
    studioRoute: true,
    panel: "skills",
  },
  {
    key: "schedules",
    label: "Sched",
    title: "Schedules",
    icon: Clock,
    to: "/schedules",
  },
  { key: "usage", label: "Usage", icon: ChartBar, to: "/analytics" },
  { key: "laios", label: "LAIOS", icon: Cpu, to: "/laios" },
  {
    key: "customization",
    label: "Custom",
    title: "Customization",
    icon: SlidersHorizontal,
    to: "/customization",
  },
]

/** Reached from the rail's footer tile rather than the list above. */
const FOOTER_ROUTES = ["/settings"]

/** Where this item goes, once the studio's workspace id is known. */
export function railItemTo(
  item: RailItem,
  studioId: string | undefined
): string | undefined {
  if (!item.studioRoute) return item.to
  return studioId ? `/workspaces/${studioId}/chat` : undefined
}

/**
 * Does this route match `to`? The root is exact — every path starts with "/",
 * so a prefix test there would swallow the whole app. Stated once and shared by
 * the rail's active state and {@link routeHasPanel}, which previously each had
 * their own copy of the rule.
 */
export function matchesRoute(pathname: string, to: string): boolean {
  return to === "/"
    ? pathname === "/"
    : pathname === to || pathname.startsWith(`${to}/`)
}

const PANEL_LESS_ROUTES = [
  ...RAIL_ITEMS.filter((item) => item.to && !item.panel).map(
    (item) => item.to as string
  ),
  ...FOOTER_ROUTES,
]

/**
 * False on the whole-page destinations: they own the window, and no list
 * belongs beside them. Usage and LAIOS have nothing of their own to put in a
 * panel, and a conversation list next to a usage chart is clutter that reads as
 * a bug.
 */
export function routeHasPanel(pathname: string): boolean {
  return !PANEL_LESS_ROUTES.some((route) => matchesRoute(pathname, route))
}
