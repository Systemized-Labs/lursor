import { useEffect } from "react"
import { Gear, List, SidebarSimple, SquaresFour } from "@phosphor-icons/react"

import { ConnectionStatus } from "@/components/layout/connection-status"
import { useSidebar } from "@/components/ui/sidebar"
import { isMacElectron } from "@/lib/platform"
import { cn } from "@/lib/utils"

/**
 * The window's own top strip: 44px, full width, above the sidebar and the
 * content both.
 *
 * It exists to end a negotiation. On macOS the app is frameless, so the traffic
 * lights float over whatever is at the top-left, and until now four separate
 * surfaces — `app-sidebar`, `workspace-chat-page`, `right-dock` and `dock-rail`
 * — each reconstructed the same 44px band and each decided for itself whether to
 * inset past the buttons, via a shared `useMacTitlebar` hook. Four answers to
 * one question, and a fifth needed every time a surface reached the top of the
 * window. Reserving the band *once*, outside everything, means no surface below
 * it has to know the traffic lights exist.
 *
 * 44px is set by the buttons, not by taste: `trafficLightPosition` in
 * electron/main.cjs insets them 15px from the top and they are ~15px tall, so
 * 44 centres them and puts anything beside them on their line.
 *
 * On a phone it is the app bar too, which is what let `MobileHeader` go: a
 * hamburger, the route's title, and `⚙`. Layouts is hidden there, because there is
 * no grid to arrange — a phone shows one surface at a time. Mobile is never
 * Electron, so the traffic-light reservation and the drag region are both absent,
 * and `pt-safe` lets the bar extend into the status-bar inset in standalone mode.
 */

/** Matches `h-11`. Exported so the shell can offset the sidebar by it. */
export const WINDOW_BAR_HEIGHT = "2.75rem"

interface WindowBarProps {
  /** Open the settings surface. */
  onOpenSettings: () => void
  /** Open the layouts picker. */
  onOpenLayouts: () => void
  /** Shown on phones only, where this bar is also the app bar. */
  title?: string
}

export function WindowBar({
  onOpenSettings,
  onOpenLayouts,
  title,
}: WindowBarProps) {
  const { toggleSidebar, open, isMobile, setOpenMobile } = useSidebar()

  // ⌘, — the platform convention for settings, and the shortcut the Settings
  // dialog will keep in Phase 2. Bound here because the bar is the one surface
  // that is mounted for every route.
  //
  // ⇧⌘\ opens the layouts picker, per the plan's §3.7. Matched on `event.code`
  // rather than `event.key`: with shift held, the backslash key reports "|", so a
  // key-based match would look for a character the chord never produces.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key === "," && !event.shiftKey) {
        event.preventDefault()
        onOpenSettings()
        return
      }
      if (event.code === "Backslash" && event.shiftKey) {
        event.preventDefault()
        onOpenLayouts()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onOpenSettings, onOpenLayouts])

  if (isMobile) {
    return (
      <header className="shrink-0 border-b border-border/60 bg-sidebar pt-safe">
        <div className="flex h-12 items-center gap-1 px-1.5">
          <button
            type="button"
            onClick={() => setOpenMobile(true)}
            aria-label="Open menu"
            className="flex size-9 shrink-0 items-center justify-center rounded-md text-sidebar-foreground hover:bg-sidebar-accent"
          >
            <List className="size-5" />
          </button>
          <h1 className="min-w-0 flex-1 truncate px-1 text-sm font-semibold text-sidebar-foreground">
            {title}
          </h1>
          {/* No Layouts here: a phone shows one surface at a time, so there is no
              grid to arrange. */}
          <button
            type="button"
            onClick={() => onOpenSettings()}
            aria-label="Settings"
            className="flex size-9 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <Gear className="size-5" />
          </button>
        </div>
      </header>
    )
  }

  return (
    <header
      className={cn(
        "flex h-11 w-full shrink-0 items-center gap-1 bg-sidebar pr-2",
        // Frameless macOS: the whole strip is a drag handle, and its buttons opt
        // back out individually (see `actionClass`).
        isMacElectron && "[-webkit-app-region:drag]"
      )}
    >
      {/* The traffic lights sit at x=14 and run to roughly x=84. Reserve 88 so
          anything that lands on the left of this bar later starts clear of them
          — nothing does yet, but the reservation is the whole point of the bar
          existing, and leaving it implicit is how the old four-surface version
          started. */}
      {isMacElectron ? <div aria-hidden className="w-[88px] shrink-0" /> : null}

      {/* Which machine this window is driving, when that is a question worth
          answering — it renders nothing at all against a local backend. This bar is
          the only surface mounted for every route, which is why it lives here. */}
      <ConnectionStatus />

      <div className="min-w-0 flex-1" />

      {/* Three controls, not the five in the plan's sketch. Notifications was cut
          outright (§10), and Keyboard shortcuts is a settings category rather than
          a glyph of its own — one button for "configure the app" is enough. */}
      <button
        type="button"
        onClick={() => onOpenLayouts()}
        aria-label="Layouts"
        title="Layouts (⇧⌘\)"
        className={actionClass}
      >
        <SquaresFour className="h-4 w-4" />
      </button>
      {/* Wrapped rather than passed straight through: the click event would
          otherwise arrive as the handler's first argument, and the settings
          opener takes an optional category there. */}
      <button
        type="button"
        onClick={() => onOpenSettings()}
        aria-label="Settings"
        title="Settings (⌘,)"
        className={actionClass}
      >
        <Gear className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={open ? "Hide sidebar" : "Show sidebar"}
        title={`${open ? "Hide" : "Show"} sidebar (⌘B)`}
        className={actionClass}
      >
        <SidebarSimple className="h-4 w-4" />
      </button>
    </header>
  )
}

/** `no-drag` so these stay clickable inside the frameless drag region. */
const actionClass =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground [-webkit-app-region:no-drag]"
