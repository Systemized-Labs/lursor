import { SidebarSimple } from "@phosphor-icons/react"

interface DockRailProps {
  /** Re-open the right dock. */
  onOpen: () => void
}

/**
 * A slim reserved gutter shown at the far-right edge only while the dock is
 * collapsed. It gives the dock a stable "reopen" affordance that lives in its
 * own layout column — so, unlike a floating button, it never overlaps the
 * routed page content. When the dock is open, hiding is handled by the dock's
 * own in-strip button, so there is never a duplicate toggle.
 */
export function DockRail({ onOpen }: DockRailProps) {
  return (
    <div className="flex w-9 shrink-0 flex-col items-center bg-background">
      {/* Top row is pinned to the same height as the chat header so the expand
          toggle lines up exactly with the header's new-chat button, and the
          `h-7 w-7` button mirrors that button's hit area. No border here — the
          rail reads as a seamless continuation of the header. It used to take
          the macOS chrome height and tone too, back when the window's top band
          had to be reassembled by every surface that reached it; the WindowBar
          owns that band now. */}
      <div className="flex h-9 shrink-0 items-center">
        <button
          type="button"
          onClick={onOpen}
          title="Show panel"
          aria-label="Show panel"
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <SidebarSimple className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
