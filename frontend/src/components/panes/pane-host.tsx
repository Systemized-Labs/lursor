import { useCallback, useEffect, useMemo, useState } from "react"
import { Plus } from "@phosphor-icons/react"
import {
  DockviewReact,
  type DockviewReadyEvent,
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
import "@/components/panes/pane-theme.css"

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

  const rightActions = useCallback(
    (props: IDockviewHeaderActionsProps) => (
      <AddPaneMenu
        layout={layout}
        groupId={props.group.api.id}
        hasWorkspace={Boolean(workspaceId)}
      />
    ),
    [layout, workspaceId]
  )

  // A layout that ends up with no panes at all would be a window with no way back
  // in. Dockview will happily hold an empty grid, so offer the same "open one" cards
  // the dock's empty state did.
  const [empty, setEmpty] = useState(false)
  useEffect(() => {
    if (!api) return
    const check = () => setEmpty(api.panels.length === 0)
    check()
    const sub = api.onDidLayoutChange(check)
    return () => sub.dispose()
  }, [api])

  return (
    <div className="relative min-h-0 min-w-0 flex-1">
      <DockviewReact
        className="dockview-theme-lursor h-full"
        components={components}
        tabComponents={{ pane: PaneTab }}
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
  // A terminal with no workspace would open a shell in whatever directory the
  // backend defaults to, and a Changes pane would have no repo to diff.
  const kinds = hasWorkspace
    ? ADDABLE_KINDS
    : ADDABLE_KINDS.filter((kind) => !WORKSPACE_KINDS.includes(kind))
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
    <div className="absolute inset-0 overflow-auto">
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
