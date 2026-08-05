import { useCallback, useEffect, useMemo, useState } from "react"
import { CaretDown, CaretUp, Plus, Terminal } from "@phosphor-icons/react"
import {
  DockviewReact,
  type DockviewReadyEvent,
  type DockviewTheme,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelProps,
} from "dockview-react"
import "dockview-react/dist/styles/dockview.css"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { PaneContent } from "@/components/panes/pane-content"
import { PaneTab } from "@/components/panes/pane-tab"
import {
  ADDABLE_KINDS,
  PANE_KINDS,
  WORKSPACE_KINDS,
  type PaneKind,
  type PaneParams,
} from "@/components/panes/pane-kinds"
import type { PaneLayout } from "@/components/panes/use-pane-layout"
import { gridPanels } from "@/components/panes/terminal-deck"
import "@/components/panes/pane-theme.css"

/**
 * Our theme, declared to dockview rather than only set as a class.
 *
 * Dockview applies `className` to the **shell** — the wrapper it puts around the grid
 * to hold its edge groups — precisely so the grid and the deck inherit the same
 * tokens. Handing it the class on the dockview element instead leaves the shell with
 * the default (`dockview-theme-abyss`, dark), and the deck then sits *outside* the
 * themed subtree: a dark drawer under a light window. See `pane-theme.css` for the
 * tokens themselves.
 *
 * `tabGroupIndicator: 'none'` is dockview's abyss default, which the app inherited
 * before it declared a theme of its own — the tab component draws its own underline.
 * No `colorScheme`: the tokens follow the app's light/dark class, so neither answer
 * would be true for long.
 */
const PANE_THEME = {
  name: "lursor",
  className: "dockview-theme-lursor",
  tabGroupIndicator: "none",
  // Matches `--dv-tabs-and-actions-container-height`. The deck measures its real
  // strip and prefers that, so this only covers the frame before the first measure.
  edgeGroupCollapsedSize: 36,
} as const satisfies DockviewTheme

interface PaneHostProps {
  workspaceId?: string
  layout: PaneLayout
  /**
   * The conversation the focused chat pane is on, mirrored to `?c=`. Routing
   * degrades from *owner* to *address* here (the plan's §4): the URL is written
   * **from** the focused pane, never read to build the layout.
   */
  onFocusedThreadChange: (threadId: string | null) => void
}

/**
 * The pane layer: dockview hosting every surface as a pane.
 *
 * Replaces the shell's one hardcoded split — a routed centre plus a right dock
 * with its own tab strip and its own four panel kinds. A chat and a terminal are
 * the same kind of thing to a user, and this is the first arrangement where the
 * app agrees.
 *
 * The load-bearing configuration is `renderer: 'always'` per kind, in
 * `pane-kinds.ts`. Phase 0 measured what it buys: a PTY, a scrolled iframe and an
 * edited Monaco buffer all survive a cross-group move, five template switches and
 * a sidebar swap, because the pane's DOM node is never reparented. See §3.8.
 */
export function PaneHost({
  workspaceId,
  layout,
  onFocusedThreadChange,
}: PaneHostProps) {
  const { api, onReady } = layout

  /**
   * One React component per kind, built once.
   *
   * Each reads its own params off the panel api and re-renders when they change,
   * so a pane re-addressed in place (a chat switched to another thread) follows
   * without the host having to re-create the component table.
   */
  const components = useMemo(() => {
    const table: Record<string, React.FunctionComponent<IDockviewPanelProps>> = {}
    for (const kind of Object.keys(PANE_KINDS) as PaneKind[]) {
      table[kind] = (props) => (
        <Pane
          {...props}
          kind={kind}
          workspaceId={workspaceId}
          onFocusedThreadChange={onFocusedThreadChange}
        />
      )
    }
    return table
  }, [workspaceId, onFocusedThreadChange])

  const handleReady = useCallback(
    (event: DockviewReadyEvent) => onReady(event.api),
    [onReady]
  )

  // The deck answers for itself: its `+` opens a shell rather than asking which
  // kind, and it is the one group with somewhere to collapse to.
  const rightActions = useCallback(
    (props: IDockviewHeaderActionsProps) =>
      props.location?.type === "edge" ? (
        <DeckActions {...props} layout={layout} />
      ) : (
        <AddPaneMenu
          layout={layout}
          groupId={props.group.api.id}
          hasWorkspace={Boolean(workspaceId)}
        />
      ),
    [layout, workspaceId]
  )

  const leftActions = useCallback(
    (props: IDockviewHeaderActionsProps) => <DeckLabel {...props} />,
    []
  )

  // A *grid* with no panes would be a window with no way back in. Dockview will
  // happily hold an empty one, so offer the same "open one" cards the dock's empty
  // state did — counting the deck's terminals would leave the grid blank and the
  // cards hidden behind a drawer.
  const [empty, setEmpty] = useState(false)
  useEffect(() => {
    if (!api) return
    const check = () => setEmpty(gridPanels(api).length === 0)
    check()
    const sub = api.onDidLayoutChange(check)
    return () => sub.dispose()
  }, [api])

  return (
    <div className="relative min-h-0 min-w-0 flex-1">
      <DockviewReact
        className="h-full"
        theme={PANE_THEME}
        components={components}
        tabComponents={{ pane: PaneTab }}
        leftHeaderActionsComponent={leftActions}
        rightHeaderActionsComponent={rightActions}
        onReady={handleReady}
        singleTabMode="default"
      />
      {empty ? (
        <EmptyLayout layout={layout} hasWorkspace={Boolean(workspaceId)} />
      ) : null}
    </div>
  )
}

/**
 * One pane, wired to its panel api.
 *
 * `params` are read reactively rather than from the initial props: dockview hands
 * the component its params at mount, but a chat pane's `threadId` changes while it
 * is mounted and the body has to follow.
 */
function Pane({
  api,
  kind,
  workspaceId,
  onFocusedThreadChange,
}: IDockviewPanelProps & {
  kind: PaneKind
  workspaceId?: string
  onFocusedThreadChange: (threadId: string | null) => void
}) {
  const [params, setParams] = useState<PaneParams>(
    () => (api.getParameters<PaneParams>() ?? { kind }) as PaneParams
  )
  useEffect(() => {
    const sub = api.onDidParametersChange(() => {
      setParams((api.getParameters<PaneParams>() ?? { kind }) as PaneParams)
    })
    return () => sub.dispose()
  }, [api, kind])

  // §3.4's gate: with `renderer: 'always'` a hidden pane keeps running, so each
  // kind is told when it is off screen and can stop the expensive half of its work
  // (a preview pausing media, an editor skipping a watcher fan-out).
  const [visible, setVisible] = useState(() => api.isVisible)
  useEffect(() => {
    setVisible(api.isVisible)
    const sub = api.onDidVisibilityChange((event) => setVisible(event.isVisible))
    return () => sub.dispose()
  }, [api])

  const [isActive, setIsActive] = useState(() => api.isActive)
  useEffect(() => {
    setIsActive(api.isActive)
    const sub = api.onDidActiveChange((event) => setIsActive(event.isActive))
    return () => sub.dispose()
  }, [api])

  /** A pane's reported detail rides on its title, which the tab reads. */
  const onDetail = useCallback(
    (detail: string | null) => {
      api.setTitle(detail ?? PANE_KINDS[kind].title)
    },
    [api, kind]
  )

  const onThreadChange = useCallback(
    (threadId: string | null) => {
      api.updateParameters({ ...params, threadId })
      // Only the focused chat writes the URL. Two chats open on two threads
      // cannot both be `?c=`, and the one you are looking at is the honest answer.
      if (api.isActive) onFocusedThreadChange(threadId)
    },
    [api, params, onFocusedThreadChange]
  )

  // Becoming the active pane re-asserts the address, so clicking between two chat
  // panes moves `?c=` with the focus.
  useEffect(() => {
    if (isActive && kind === "chat") {
      onFocusedThreadChange(params.threadId ?? null)
    }
  }, [isActive, kind, params.threadId, onFocusedThreadChange])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <PaneContent
        kind={kind}
        workspaceId={workspaceId}
        paneId={api.id}
        active={visible}
        onDetail={onDetail}
        threadId={params.threadId ?? null}
        onThreadChange={onThreadChange}
      />
    </div>
  )
}

/**
 * The deck's own strip: put it away, bring it back, or add a shell.
 *
 * The collapsed state is read from dockview rather than tracked here — an edge group
 * knows whether it is collapsed, and it is the only thing that does. `collapse()`
 * pins the drawer to the height of this very strip until `expand()`, which is why
 * there is no size arithmetic anywhere in this component. See `terminal-deck.ts`.
 */
function DeckActions({
  api,
  panels,
  layout,
}: IDockviewHeaderActionsProps & { layout: PaneLayout }) {
  const [collapsed, setCollapsed] = useState(() => api.isCollapsed())
  useEffect(() => {
    setCollapsed(api.isCollapsed())
    const sub = api.onDidCollapsedChange((event) =>
      setCollapsed(event.isCollapsed)
    )
    return () => sub.dispose()
  }, [api])

  const label = collapsed ? "Show the terminal deck" : "Hide the terminal deck"

  return (
    <div className="flex items-center">
      {/* Nothing to reveal in an empty drawer: until there is a shell in it, the
          strip's only job is the `+`. */}
      {panels.length > 0 ? (
        <button
          type="button"
          onClick={() => (collapsed ? api.expand() : api.collapse())}
          title={label}
          aria-label={label}
          aria-expanded={!collapsed}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {collapsed ? (
            <CaretUp className="size-4" />
          ) : (
            <CaretDown className="size-4" />
          )}
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => layout.openPane("terminal")}
        title="New terminal"
        aria-label="New terminal"
        className="mr-1 flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <Plus className="size-4" />
      </button>
    </div>
  )
}

/**
 * The deck's name, while it has no tabs to show one.
 *
 * A 36px band with a lone `+` in the corner reads as something half-rendered. The
 * label only appears on an empty deck: once a shell is in there its tab says the
 * same thing, and two of them is noise.
 */
function DeckLabel({ location, panels }: IDockviewHeaderActionsProps) {
  if (location?.type !== "edge" || panels.length > 0) return null
  return (
    <span className="flex items-center gap-1.5 pl-2 text-[11px] text-muted-foreground">
      <Terminal className="size-3.5" />
      Terminal
    </span>
  )
}

/** The `+` on a zone's tab strip. */
function AddPaneMenu({
  layout,
  groupId,
  hasWorkspace,
}: {
  layout: PaneLayout
  groupId: string
  hasWorkspace: boolean
}) {
  // A global layout offers only the kinds that mean something without a workspace.
  // A Changes pane would have no repo to diff, and a terminal no directory to run
  // in. Terminals are left out of this menu everywhere: a `+` on a zone's strip
  // means "here", and a terminal opens in the deck — which has its own `+` for it.
  const kinds = ADDABLE_KINDS.filter(
    (kind) =>
      kind !== "terminal" && (hasWorkspace || !WORKSPACE_KINDS.includes(kind))
  )
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Add pane"
          aria-label="Add pane"
          className="mr-1 flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Plus className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {kinds.map((kind) => {
          const def = PANE_KINDS[kind]
          const Icon = def.icon
          return (
            <DropdownMenuItem
              key={kind}
              onSelect={() => layout.openPane(kind, { groupId })}
            >
              <Icon className="size-4" />
              {def.title}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Shown over an empty grid — the dock's empty-state cards, re-homed. */
function EmptyLayout({
  layout,
  hasWorkspace,
}: {
  layout: PaneLayout
  hasWorkspace: boolean
}) {
  const kinds = hasWorkspace
    ? ADDABLE_KINDS
    : ADDABLE_KINDS.filter((kind) => !WORKSPACE_KINDS.includes(kind))
  // The cards are sized, not shaped. `aspect-square` here meant a card in a wide
  // grid grew as tall as the column, so nine kinds overflowed the pane in both
  // directions with nothing to scroll — hence the fixed height, the capped width
  // and the scroll container around it.
  return (
    // `z-10` clears anything dockview stacks over its own grid; see the watermark
    // note in `pane-theme.css`.
    <div className="absolute inset-0 z-10 overflow-auto">
      <div className="mx-auto grid min-h-full max-w-2xl grid-cols-2 content-center gap-3 p-6 sm:grid-cols-3">
        {kinds.map((kind) => {
          const def = PANE_KINDS[kind]
          const Icon = def.icon
          return (
            <button
              key={kind}
              type="button"
              onClick={() => layout.openPane(kind)}
              className="flex h-28 flex-col items-center justify-center gap-2 rounded-xl bg-muted/40 text-sm text-foreground shadow-sm transition-all hover:bg-muted hover:shadow-md"
            >
              <Icon className="size-6 text-muted-foreground" />
              {def.title}
            </button>
          )
        })}
      </div>
    </div>
  )
}
