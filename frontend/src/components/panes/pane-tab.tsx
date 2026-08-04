import { useEffect, useState } from "react"
import { X } from "@phosphor-icons/react"
import type { IDockviewPanelHeaderProps } from "dockview-react"

import { PANE_KINDS, type PaneParams } from "@/components/panes/pane-kinds"
import { cn } from "@/lib/utils"

/**
 * A pane's tab: uppercase label, an active underline, and a close affordance that
 * appears on hover.
 *
 * Dockview owns the tab strip and the drag overlay, so the Hermes look needs a
 * custom `tabComponent` rather than variable overrides alone (the plan's §3.4 said
 * as much). What it gets from us is the label treatment and the underline; the
 * strip's background, height and drop targets come from the theme class in
 * `pane-theme.css`.
 *
 * The detail suffix — a port, a filename — is only shown while a kind is open more
 * than once. It exists to tell duplicates apart, and a strip this narrow should
 * not spend width restating what a lone "Preview" is already pointed at. Same rule
 * the right dock's strip used, and the detail is still derived from live pane state
 * rather than persisted.
 */
export function PaneTab(props: IDockviewPanelHeaderProps) {
  const params = props.params as PaneParams | undefined
  const kind = params?.kind
  const def = kind ? PANE_KINDS[kind] : undefined

  const [active, setActive] = useState(() => props.api.isActive)
  useEffect(() => {
    setActive(props.api.isActive)
    const sub = props.api.onDidActiveChange((event) => setActive(event.isActive))
    return () => sub.dispose()
  }, [props.api])

  // How many panes of this kind are open, so the detail suffix can be suppressed
  // when there is nothing to disambiguate. Recomputed on layout change rather
  // than held in state elsewhere: the count is a fact about the layout, and the
  // layout already broadcasts when it changes.
  const [duplicated, setDuplicated] = useState(false)
  useEffect(() => {
    const recount = () => {
      const same = props.containerApi.panels.filter(
        (panel) => (panel.params as PaneParams | undefined)?.kind === kind
      )
      setDuplicated(same.length > 1)
    }
    recount()
    const sub = props.containerApi.onDidLayoutChange(recount)
    return () => sub.dispose()
  }, [props.containerApi, kind])

  const [detail, setDetail] = useState<string | null>(null)
  useEffect(() => {
    setDetail(null)
    const sub = props.api.onDidTitleChange((event) => {
      // A pane reports its detail by setting its own title; the label below stays
      // the kind's name, so the tab never loses track of what it *is*.
      setDetail(event.title === def?.title ? null : (event.title ?? null))
    })
    return () => sub.dispose()
  }, [props.api, def?.title])

  const Icon = def?.icon
  const label = def?.title ?? props.api.title ?? "Pane"

  return (
    <div
      className={cn(
        "group/tab relative flex h-full min-w-0 items-center gap-1.5 px-2.5",
        active
          ? "text-foreground"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {Icon ? <Icon className="size-3.5 shrink-0" /> : null}
      <span className="min-w-0 truncate text-[11px] font-medium uppercase tracking-[0.08em]">
        {label}
      </span>
      {duplicated && detail ? (
        <span className="min-w-0 max-w-[7rem] truncate text-[10px] normal-case tracking-normal opacity-70">
          {detail}
        </span>
      ) : null}

      <button
        type="button"
        aria-label={`Close ${label}`}
        onClick={(event) => {
          event.stopPropagation()
          props.api.close()
        }}
        className="ml-0.5 shrink-0 rounded p-0.5 opacity-0 hover:bg-accent group-hover/tab:opacity-100 focus-visible:opacity-100"
      >
        <X className="size-3" />
      </button>

      {/* The active underline. An `after`-style bar rather than a border so it
          sits over the strip's own bottom edge instead of shifting the row. */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-x-0 bottom-0 h-[2px]",
          active ? "bg-primary" : "bg-transparent"
        )}
      />
    </div>
  )
}
