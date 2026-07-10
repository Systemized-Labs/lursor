import { PanelRight } from "lucide-react"

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
    <div className="flex w-9 shrink-0 flex-col items-center border-l border-border bg-background py-2">
      <button
        type="button"
        onClick={onOpen}
        title="Show panel"
        aria-label="Show panel"
        className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <PanelRight className="h-4 w-4" />
      </button>
    </div>
  )
}
