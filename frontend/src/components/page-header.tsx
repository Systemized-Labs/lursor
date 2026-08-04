import type { ReactNode } from "react"

interface PageHeaderProps {
  title: string
  description?: string
  actions?: ReactNode
  /**
   * Rendered inside a pane, where the tab already names the surface.
   *
   * Only the *title* goes; the description and the actions stay, because those
   * carry real content — a connection selector, a date range — and a pane needs
   * them as much as a page did. This is the same treatment the title already gets
   * on mobile, where a global header names the route, so it is one rule with two
   * triggers rather than a second way of hiding a heading.
   */
  embedded?: boolean
}

export function PageHeader({
  title,
  description,
  actions,
  embedded = false,
}: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-1">
        {/* The mobile header, or a pane's tab, already shows this title — so hide
            the large in-page heading there (kept for screen readers). */}
        <h1
          className={
            embedded
              ? "sr-only"
              : "sr-only text-2xl font-semibold tracking-tight text-foreground sm:not-sr-only"
          }
        >
          {title}
        </h1>
        {description ? (
          <p className="text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  )
}
