import { List } from "@phosphor-icons/react"
import type { ReactNode } from "react"

import { useSidebar } from "@/components/ui/sidebar"

interface MobileHeaderProps {
  /** Contextual page title shown next to the menu button. */
  title: string
  /** Optional right-aligned actions (e.g. a page's primary control). */
  right?: ReactNode
}

/**
 * The global top app bar on phones: a hamburger that opens the off-canvas
 * sidebar, a contextual page title, and an optional actions slot. Rendered once
 * by the shell for every mobile route so content flows beneath a real header
 * instead of under a floating button.
 *
 * `pt-safe` lets the bar extend into the status-bar inset in standalone mode.
 */
export function MobileHeader({ title, right }: MobileHeaderProps) {
  const { setOpenMobile } = useSidebar()
  return (
    <header className="shrink-0 border-b border-border/60 bg-background/95 pt-safe backdrop-blur">
      <div className="flex h-12 items-center gap-1 px-1.5">
        <button
          type="button"
          onClick={() => setOpenMobile(true)}
          aria-label="Open menu"
          className="flex size-9 shrink-0 items-center justify-center rounded-md text-foreground transition-colors hover:bg-accent"
        >
          <List className="size-5" />
        </button>
        <h1 className="min-w-0 flex-1 truncate px-1 text-sm font-semibold text-foreground">
          {title}
        </h1>
        {right ? (
          <div className="flex shrink-0 items-center gap-0.5">{right}</div>
        ) : null}
      </div>
    </header>
  )
}
