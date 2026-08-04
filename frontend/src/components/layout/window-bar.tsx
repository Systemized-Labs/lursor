import { useEffect } from "react"
import { Gear, SidebarSimple } from "@phosphor-icons/react"

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
 * Desktop only for now. Mobile keeps `MobileHeader` until the mobile pass —
 * mobile is never Electron, so there is no chrome to reserve there, and two
 * stacked bars would cost a phone 88px of nothing.
 */

/** Matches `h-11`. Exported so the shell can offset the sidebar by it. */
export const WINDOW_BAR_HEIGHT = "2.75rem"

interface WindowBarProps {
  /** Open the settings surface. */
  onOpenSettings: () => void
}

export function WindowBar({ onOpenSettings }: WindowBarProps) {
  const { toggleSidebar, open } = useSidebar()

  // ⌘, — the platform convention for settings, and the shortcut the Settings
  // dialog will keep in Phase 2. Bound here because the bar is the one surface
  // that is mounted for every route.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "," || !(event.metaKey || event.ctrlKey)) return
      event.preventDefault()
      onOpenSettings()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onOpenSettings])

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

      <div className="min-w-0 flex-1" />

      {/* Deliberately two controls, not the five in the plan's sketch. Layouts
          and Keyboard shortcuts have nothing behind them until Phases 5 and 2;
          Notifications was cut outright. A button that opens nothing is worse
          than a gap where one will go. */}
      <button
        type="button"
        onClick={onOpenSettings}
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
