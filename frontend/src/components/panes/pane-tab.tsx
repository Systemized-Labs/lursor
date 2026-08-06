import { useCallback, useEffect, useMemo, useState } from "react"
import { X } from "@phosphor-icons/react"
import type { IDockviewPanel, IDockviewPanelHeaderProps } from "dockview-react"

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  PANE_KINDS,
  paneKindOf,
  paneParamsOf,
  type PaneParams,
} from "@/components/panes/pane-kinds"
import { DotGridLoader } from "@/components/ui/dot-grid-loader"
import { useActiveRuns, useThread } from "@/api/threads"
import { useOptimisticRuns } from "@/hooks/use-optimistic-runs"
import { useThreadReads } from "@/hooks/use-thread-reads"
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
 *
 * A preview tab — the ephemeral one a single click in the sidebar re-uses — is
 * italic, VS Code's own signal, and double-clicking it is one of the ways to keep
 * it. See `PaneParams.preview`.
 *
 * Chat is the exception, and takes the detail as its *label*. A conversation has a
 * name of its own — the one the header renames and the sidebar lists — so a strip
 * of tabs all reading "CHAT" is the one case where the kind is the least useful
 * thing we could print. Two chats side by side need telling apart whether or not
 * they are "duplicates", and the icon still says what the pane is.
 */
export function PaneTab(props: IDockviewPanelHeaderProps) {
  const kind = (props.params as PaneParams | undefined)?.kind
  const def = kind ? PANE_KINDS[kind] : undefined

  /**
   * Whether this is a preview pane.
   *
   * Two sources, and both are needed. `props.params` is right at mount but goes
   * stale: promotion re-addresses a pane that is already on screen, and dockview
   * re-renders the tab with the params it was constructed with. The panel's own
   * `params` is the live value — the one `use-pane-layout` matches on.
   *
   * `props.api.getParameters()` is neither, and must not be used: it holds a copy of
   * the last object passed to `updateParameters`, so it reads `{}` before the first
   * one and `{ preview: undefined }` after a promotion. See the note on `Pane` in
   * `pane-host`, which lost a pane's whole address to it.
   */
  const [preview, setPreview] = useState(
    () => Boolean((props.params as PaneParams | undefined)?.preview)
  )
  useEffect(() => {
    const read = () => {
      const panel = props.containerApi.getPanel(props.api.id)
      setPreview(Boolean(panel && paneParamsOf(panel)?.preview))
    }
    read()
    const sub = props.api.onDidParametersChange(read)
    return () => sub.dispose()
  }, [props.api, props.containerApi])

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
        (panel) => paneKindOf(panel) === kind
      )
      setDuplicated(same.length > 1)
    }
    recount()
    const sub = props.containerApi.onDidLayoutChange(recount)
    return () => sub.dispose()
  }, [props.containerApi, kind])

  // A pane reports its detail by setting its own title. Seeded from the current
  // title rather than from null, so a tab that mounts against a pane which already
  // reported one — a remount, a restored layout — shows it immediately instead of
  // waiting for the next change event that may never come.
  const [detail, setDetail] = useState<string | null>(() =>
    props.api.title && props.api.title !== def?.title ? props.api.title : null
  )
  useEffect(() => {
    const sync = (title: string | null | undefined) =>
      setDetail(!title || title === def?.title ? null : title)
    sync(props.api.title)
    const sub = props.api.onDidTitleChange((event) => sync(event.title))
    return () => sub.dispose()
  }, [props.api, def?.title])

  // --- Chat tab status: running (grid dots) or unread (solid dot) -----------
  // The threadId can change when a preview pane is re-addressed, so it is read
  // from the live panel params rather than captured once at mount.
  const [threadId, setThreadId] = useState<string | null>(
    () => (props.params as PaneParams | undefined)?.threadId ?? null
  )
  useEffect(() => {
    const read = () => {
      const panel = props.containerApi.getPanel(props.api.id)
      setThreadId(panel ? paneParamsOf(panel)?.threadId ?? null : null)
    }
    read()
    const sub = props.api.onDidParametersChange(read)
    return () => sub.dispose()
  }, [props.api, props.containerApi])

  const isChat = kind === "chat"
  const threadQuery = useThread(isChat && threadId ? threadId : undefined)
  const activeRunsQuery = useActiveRuns()
  const optimisticRuns = useOptimisticRuns()
  const activeRuns = useMemo(
    () => new Set([...(activeRunsQuery.data ?? []), ...optimisticRuns]),
    [activeRunsQuery.data, optimisticRuns]
  )
  const { isUnread } = useThreadReads()

  const running = isChat && !!threadId && activeRuns.has(threadId)
  const unread =
    isChat &&
    !!threadId &&
    !running &&
    !!threadQuery.data?.updated_at &&
    isUnread(threadId, threadQuery.data.updated_at)


  const Icon = def?.icon
  // A named conversation labels its own tab; an unnamed one falls back to the kind,
  // which is also what a chat shows while its first turn is still being titled.
  const named = kind === "chat" && detail ? shorten(detail) : null
  const label = named ?? def?.title ?? props.api.title ?? "Pane"

  // ── Context menu actions ──────────────────────────────────────────────────
  // The group's panels are read fresh on each click rather than captured in a
  // ref: dockview mutates the array as tabs close, so a stale snapshot would
  // double-fire on "Close All" or miss a tab that was dragged in between.

  const closeThis = useCallback(() => {
    props.api.close()
  }, [props.api])

  const closeOthers = useCallback(() => {
    const targets = props.containerApi.panels.filter(
      (p: IDockviewPanel) => p.api.id !== props.api.id
    )
    for (const p of targets) p.api.close()
  }, [props.api, props.containerApi])

  const closeToRight = useCallback(() => {
    const panels = props.containerApi.panels
    const idx = panels.findIndex(
      (p: IDockviewPanel) => p.api.id === props.api.id
    )
    if (idx < 0) return
    const targets = panels.slice(idx + 1)
    for (const p of targets) p.api.close()
  }, [props.api, props.containerApi])

  const closeAll = useCallback(() => {
    const targets = [...props.containerApi.panels]
    for (const p of targets) p.api.close()
  }, [props.containerApi])

  // Whether there are any siblings to the right, for disabling the item.
  // Computed on every render rather than memoised: dockview mutates the
  // panels array in place, so the reference never changes and a memo would
  // go stale. The component already re-renders on layout change.
  const panels = props.containerApi.panels
  const myIndex = panels.findIndex(
    (p: IDockviewPanel) => p.api.id === props.api.id
  )
  const hasRight = myIndex >= 0 && myIndex < panels.length - 1
  const hasOthers = panels.length > 1

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
    <div
      // Double-clicking a preview tab keeps it, as it does in VS Code. Dockview binds
      // no `dblclick` of its own on a tab, so nothing is being overridden here.
      onDoubleClick={() => props.api.updateParameters({ preview: undefined })}
      className={cn(
        "group/tab relative flex h-full min-w-0 items-center gap-1.5 px-2.5",
        active
          ? "text-foreground"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {running ? (
        <DotGridLoader size="2xs" label="Conversation active" />
      ) : unread ? (
        <span
          aria-label="Unread reply"
          className="size-2 shrink-0 rounded-full bg-current"
        />
      ) : Icon ? (
        <Icon className="size-3.5 shrink-0" />
      ) : null}
      <span
        title={named && named !== detail ? (detail ?? undefined) : undefined}
        className={cn(
          "min-w-0 truncate text-[11px] font-medium uppercase tracking-[0.08em]",
          // A kind's name is two syllables and can size to content; a conversation's
          // is a sentence, and is held to a share of the strip.
          named && "max-w-[10rem]",
          // Italic says the tab is on loan — the one the next click will re-use.
          preview && "italic"
        )}
      >
        {label}
      </span>
      {!named && duplicated && detail ? (
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
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={closeThis}>Close</ContextMenuItem>
        <ContextMenuItem onSelect={closeOthers} disabled={!hasOthers}>
          Close Others
        </ContextMenuItem>
        <ContextMenuItem onSelect={closeToRight} disabled={!hasRight}>
          Close to the Right
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={closeAll}>Close All</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** How many characters of a conversation name a tab will print. */
const NAME_LIMIT = 24

/**
 * A conversation name, cut to tab length.
 *
 * Truncation happens here as well as in CSS on purpose: `truncate` alone would let
 * one long name push every other tab's label down to a few letters, since dockview
 * sizes tabs to content and only the overflow gets clipped. Cutting the string caps
 * the tab's *width*; the class then handles whatever still doesn't fit.
 *
 * The cut prefers the last word boundary so it lands between words rather than
 * mid-word, unless that would throw away more than half the budget.
 */
function shorten(name: string): string {
  const clean = name.trim().replace(/\s+/g, " ")
  if (clean.length <= NAME_LIMIT) return clean
  const cut = clean.slice(0, NAME_LIMIT)
  const space = cut.lastIndexOf(" ")
  return `${space > NAME_LIMIT / 2 ? cut.slice(0, space) : cut.trimEnd()}…`
}
