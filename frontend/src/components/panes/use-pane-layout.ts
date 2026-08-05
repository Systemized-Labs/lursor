import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { DockviewApi, IDockviewPanel, SerializedDockview } from "dockview-react"

import {
  HORIZONTAL,
  branch,
  leaf,
  panelState,
} from "@/components/panes/layout-shapes"
import {
  isPaneKind,
  newPaneId,
  PANE_KINDS,
  paneKindOf,
  paneParamsOf,
  type PaneKind,
  type PaneParams,
} from "@/components/panes/pane-kinds"
import {
  bottomPanelId,
  gridPanes,
  migrateEdgeGroup,
  openInBottomPanel,
  readPanelState,
  restorePanelState,
  revealPanel,
  syncBottomPanel,
  type BottomPanelState,
} from "@/components/panes/bottom-panel"
import { clearTabStorage } from "@/lib/tab-storage"

const LAYOUT_PREFIX = "lursor:layout:"
/** The right dock's old per-workspace key, read once for the migration. */
const LEGACY_PREFIX = "lursor:dock:"
/**
 * The bottom panel's own key: collapsed or not, and the height to come back to.
 *
 * Beside the layout rather than inside it, because the layout is dockview's
 * `SerializedDockview` verbatim and these two are ours — constraints do not serialize. Its
 * own key also means a corrupt or absent entry costs the panel's collapsed memory and not
 * the whole arrangement.
 */
const PANEL_PREFIX = "lursor:bottom:"

const layoutKey = (workspaceId?: string) =>
  `${LAYOUT_PREFIX}${workspaceId ?? "_global"}`
const legacyKey = (workspaceId?: string) =>
  `${LEGACY_PREFIX}${workspaceId ?? "_global"}`
const panelKey = (workspaceId?: string) =>
  `${PANEL_PREFIX}${workspaceId ?? "_global"}`

/** A one-chat-pane layout, for a workspace with nothing saved. */
function defaultLayout(): SerializedDockview {
  const id = newPaneId()
  return {
    grid: {
      root: branch([leaf("main", [id], 100)]),
      height: 1000,
      width: 1000,
      orientation: HORIZONTAL,
    },
    panels: { [id]: panelState(id, { kind: "chat", threadId: null }) },
    activeGroup: "main",
  }
}

// ── legacy migration ────────────────────────────────────────────────────────

interface LegacyTab {
  id: string
  kind: string
}

/**
 * Turn the right dock's saved state into a dockview layout.
 *
 * The important part is that **pane ids are carried over unchanged**: a preview's
 * URL and a file pane's open buffers live under `lursor:tab:<id>:*`, so a fresh id
 * would silently reset every panel the user had arranged. The shape is the same
 * one the dock had — a chat on the left, the dock's tabs grouped on the right —
 * because that is what the user is looking at when they upgrade, and a layout that
 * rearranges itself on first launch reads as data loss.
 *
 * The old key is left in place rather than deleted, for one release. If this
 * migration is wrong, the fix is a code change and not a recovery job.
 */
function migrateLegacy(workspaceId?: string): SerializedDockview | null {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(legacyKey(workspaceId))
  } catch {
    return null
  }
  if (!raw) return null

  let stored: { tabs?: unknown; activeIndex?: number; collapsed?: boolean }
  try {
    stored = JSON.parse(raw)
  } catch {
    return null
  }

  const tabs: LegacyTab[] = Array.isArray(stored.tabs)
    ? stored.tabs.flatMap((entry) => {
        // Tolerate the pre-multi-tab format, a bare `DockKind[]`.
        const kind = typeof entry === "string" ? entry : (entry as LegacyTab)?.kind
        const id = typeof entry === "string" ? newPaneId() : (entry as LegacyTab)?.id
        if (!isPaneKind(kind) || kind === "chat") return []
        return [{ id: typeof id === "string" && id ? id : newPaneId(), kind }]
      })
    : []

  const chatId = newPaneId()
  const panels: Record<string, ReturnType<typeof panelState>> = {
    [chatId]: panelState(chatId, { kind: "chat", threadId: null }),
  }
  for (const tab of tabs) {
    panels[tab.id] = panelState(tab.id, { kind: tab.kind as PaneKind })
  }

  // A collapsed dock had no visible panels, so it migrates to chat alone — the
  // tabs are dropped rather than reopened, because reopening a dock the user shut
  // is the opposite of restoring their layout.
  const sideIds = stored.collapsed ? [] : tabs.map((t) => t.id)

  return {
    grid: {
      root: sideIds.length
        ? branch([leaf("main", [chatId], 60), leaf("side", sideIds, 40)])
        : branch([leaf("main", [chatId], 100)]),
      height: 1000,
      width: 1000,
      orientation: HORIZONTAL,
    },
    panels,
    activeGroup: "main",
  }
}

// ── the hook ────────────────────────────────────────────────────────────────

function readLayout(workspaceId?: string): SerializedDockview | null {
  try {
    const raw = localStorage.getItem(layoutKey(workspaceId))
    // `migrateEdgeGroup` on the way out, always: a layout saved while the bottom panel was
    // dockview's edge group names its panes in `edgeGroups`, and handing that to `fromJSON`
    // would have dockview build the edge group back.
    if (raw) return migrateEdgeGroup(JSON.parse(raw) as SerializedDockview)
  } catch {
    // Corrupt or unreadable: fall through to the migration, then the default.
  }
  return migrateLegacy(workspaceId)
}

function readPanel(workspaceId?: string): Partial<BottomPanelState> | null {
  try {
    const raw = localStorage.getItem(panelKey(workspaceId))
    if (raw) return JSON.parse(raw) as Partial<BottomPanelState>
  } catch {
    // Best-effort: the panel opens at its default height.
  }
  return null
}

/**
 * Where a pane with no zone of its own goes — never the bottom row.
 *
 * Dockview's own answer is "the active group", and that answer is wrong when the active
 * group is the bottom row: with a terminal focused, "open Changes" would tab a diff in
 * behind the shell and then collapse it out of sight with the panel. Undefined means
 * dockview's answer is already an ordinary zone and can stand.
 *
 * The zone chosen is the one the user last worked in — the same MRU rule `ensurePane`
 * follows, and for the same reason: it is the zone they are looking at. A layout with
 * nothing else left in it gets a new zone rather than borrowing the bottom row.
 */
function gridGroupId(api: DockviewApi, mru: string[]): string | undefined {
  const bottom = bottomPanelId(api)
  if (!bottom || api.activeGroup?.api.id !== bottom) return undefined
  const byId = new Map(api.panels.map((panel) => [panel.api.id, panel]))
  const recent = mru
    .map((id) => byId.get(id))
    .find(
      (panel): panel is IDockviewPanel =>
        panel !== undefined && panel.api.group.api.id !== bottom
    )
  const inGrid = recent ?? gridPanes(api)[0]
  return inGrid ? inGrid.api.group.api.id : api.addGroup().api.id
}

export interface PaneLayout {
  /** Set once dockview is ready. */
  api: DockviewApi | null
  onReady: (api: DockviewApi) => void
  /**
   * Add a pane of `kind` and focus it — always a new one, even when one of that
   * kind is already open. Two previews on different ports, or two chats on two
   * threads, are legitimate layouts; each carries its own state under its own id.
   *
   * Where it lands is the *caller's* to say, and the same for every kind:
   * `groupId` for a named zone, `target: 'bottom'` for the bottom row, neither for the zone
   * the user last worked in. Terminals used to be routed to the bottom by kind here, which
   * meant a `+` on a zone's strip quietly ignored the zone you clicked — see `target`
   * below.
   */
  openPane: (
    kind: PaneKind,
    opts?: {
      params?: Partial<PaneParams>
      groupId?: string
      /**
       * Put it in the bottom row — creating the row if there is not one yet.
       *
       * A property of the *request*, not of the kind. Only a template whose schematic draws
       * the bottom band asks for it. Anything else — a zone's `+`, an empty-state card, a
       * route, a drag — is asking for a pane in a named zone, and a terminal is not special
       * enough to overrule that.
       */
      target?: "bottom"
    }
  ) => void
  /**
   * Reveal a pane of `kind` for a request arriving from elsewhere in the app.
   * Ported from `use-dock-state`'s `ensureTab`; see the comment on it.
   */
  ensurePane: (kind: PaneKind) => void
  /**
   * Point a chat pane at `threadId` and focus it. `null` means a new conversation.
   *
   * The targeting rule is `ensurePane`'s, for the same reason: opening a
   * conversation displaces whatever that pane held, so it has to be the chat you
   * are looking at and not one you forgot was open.
   */
  openThread: (threadId: string | null) => void
}

/**
 * The pane layer's state: which panes are open, where, and per workspace.
 *
 * Dockview owns the grid geometry and the zone/tab structure. What is ours is the
 * pane identity, the per-workspace scoping, and the targeting rule below.
 *
 * Persistence is `toJSON()` under `lursor:layout:<workspaceId>`, written on
 * dockview's own layout-change event, and — critically — **never on a workspace
 * switch**. The same trap `use-dock-state` documents: on the render where the
 * active workspace changes, a write would land the previous workspace's layout in
 * the new one's key.
 */
export function usePaneLayout(workspaceId?: string): PaneLayout {
  const [api, setApi] = useState<DockviewApi | null>(null)
  // Focus order, most recent first. Session-only: a reload starts it from the
  // restored active pane, exactly as the dock's `mru` did.
  const mru = useRef<string[]>([])
  // The workspace whose layout is currently loaded. Guards the write.
  const loadedFor = useRef<string | undefined>(undefined)
  // Set while `load` is swapping one workspace's layout for another's. See the
  // `onDidRemovePanel` handler: those removals are not closures.
  const loading = useRef(false)

  const write = useCallback((target: DockviewApi, ws?: string) => {
    try {
      localStorage.setItem(layoutKey(ws), JSON.stringify(target.toJSON()))
      // The bottom panel's two fields ride alongside. `toJSON` records the row's height like
      // any other zone's — what it cannot record is that a 36px row is *collapsed* rather
      // than dragged that small, or the height it should come back to.
      localStorage.setItem(panelKey(ws), JSON.stringify(readPanelState(target)))
    } catch {
      // Ignore quota / disabled-storage errors — persistence is best-effort.
    }
  }, [])

  const load = useCallback(
    (target: DockviewApi, ws?: string) => {
      // Every panel of the outgoing workspace is about to be removed. They are being
      // *unloaded*, not closed, so `onDidRemovePanel` must not treat them as closures
      // and drop their `lursor:tab:<id>:*` state — the layout still names those ids and
      // will restore them the moment the workspace comes back.
      loading.current = true
      try {
        const stored = readLayout(ws)
        if (!stored && !ws) {
          // A *global* layout has no sensible default. `defaultLayout` seeds a chat
          // pane, and a chat with no workspace has nothing to talk to — so start
          // empty and let the route that brought you here ensure its own pane (see
          // `PANE_ROUTES` in the shell). The empty-state cards cover arriving with no
          // route at all.
          target.clear()
          loadedFor.current = ws
          mru.current = []
          restorePanelState(target, null)
          return
        }
        const layout = stored ?? defaultLayout()
        try {
          target.fromJSON(layout)
        } catch {
          // A layout dockview refuses (a hand-edited key, a shape from a future
          // version) must not leave an empty window with no way back.
          target.clear()
          if (ws) target.fromJSON(defaultLayout())
        }
        loadedFor.current = ws
        mru.current = target.activePanel ? [target.activePanel.api.id] : []
        // The bottom panel's own two fields, which the grid tree cannot carry: collapsed or
        // not, and the height to come back to. Must follow `fromJSON` — the group it pins is
        // the one that call just built.
        restorePanelState(target, readPanel(ws))
        // Commit immediately rather than waiting for the first change. Dockview only
        // fires `onDidLayoutChange` when something *changes*, so a migrated or
        // defaulted layout would otherwise never be written — and would be re-derived
        // from the legacy key on every launch, handing the chat pane a new id each
        // time and losing whatever it had stored.
        write(target, ws)
      } finally {
        loading.current = false
      }
    },
    [write]
  )

  const onReady = useCallback(
    (target: DockviewApi) => {
      setApi(target)
      load(target, workspaceId)
    },
    [load, workspaceId]
  )

  // Reload on a workspace switch. `loadedFor` is what makes this safe to run in
  // an effect: it only fires when the id actually differs from what is mounted.
  useEffect(() => {
    if (!api) return
    if (loadedFor.current === workspaceId) return
    load(api, workspaceId)
  }, [api, workspaceId, load])

  // Persist, and keep the MRU fresh. Guarded on `loadedFor` so the write that
  // dockview fires *during* a `fromJSON` for a new workspace cannot be attributed
  // to the old one.
  useEffect(() => {
    if (!api) return
    const persist = () => {
      // Never on a workspace switch: on the render where the active workspace
      // changes, a write would land the previous workspace's layout in the new
      // one's key. `loadedFor` is what makes that impossible.
      if (loadedFor.current !== workspaceId) return
      write(api, workspaceId)
    }
    const subs = [
      // The bottom panel is a zone, so its size and its contents arrive on this one event
      // like everything else — it had two subscriptions of its own as an edge group.
      // `syncBottomPanel` first: it re-applies the pin after a `fromJSON` builds new groups,
      // and tracks the height a sash drag left the panel at, both of which the write that
      // follows is meant to capture.
      api.onDidLayoutChange(() => {
        syncBottomPanel(api)
        persist()
      }),
      api.onDidActivePanelChange((event) => {
        if (!event.panel) return
        const id = event.panel.api.id
        mru.current = [id, ...mru.current.filter((x) => x !== id)]
      }),
      // A closed pane is gone for good, so drop whatever it persisted rather
      // than leaving an orphaned `lursor:tab:<id>:*` entry behind.
      //
      // Not during a `load`, though: switching workspaces removes every pane of the
      // outgoing one, and those are unloads. Clearing there would wipe the preview
      // URLs and open buffers of the workspace you just left, and the layout that
      // still names those ids would restore them empty on the way back.
      api.onDidRemovePanel((panel) => {
        if (!loading.current) clearTabStorage(panel.api.id)
        mru.current = mru.current.filter((x) => x !== panel.api.id)
      }),
    ]
    return () => subs.forEach((sub) => sub.dispose())
  }, [api, workspaceId, write])

  const openPane = useCallback(
    (
      kind: PaneKind,
      opts?: {
        params?: Partial<PaneParams>
        groupId?: string
        target?: "bottom"
      }
    ) => {
      if (!api) return
      const panel = {
        id: newPaneId(),
        component: kind,
        tabComponent: "pane",
        title: PANE_KINDS[kind].title,
        renderer: PANE_KINDS[kind].renderer,
        params: { kind, ...opts?.params } satisfies PaneParams,
      }
      // The bottom row, for the callers that mean the bottom row. This used to be
      // `kind === "terminal"`, which made it impossible to open a shell anywhere else: the
      // branch returned before `groupId` was ever read, so a `+` on a zone's strip dropped a
      // terminal along the bottom and expanded it — indistinguishable, from the outside,
      // from the app inventing a panel nobody asked for.
      if (opts?.target === "bottom") {
        openInBottomPanel(api, panel)
        return
      }
      // A `+` on a zone's strip means "here", not "wherever dockview decides". For
      // every kind: a terminal goes where you dropped it, like a diff or a preview.
      const groupId = opts?.groupId ?? gridGroupId(api, mru.current)
      api.addPanel({
        ...panel,
        ...(groupId
          ? {
              floating: false as const,
              position: { referenceGroup: groupId, direction: "within" as const },
            }
          : {}),
      })
    },
    [api]
  )

  /**
   * Focus an existing pane of `kind`, or add one.
   *
   * With duplicates allowed, *which* one matters — the request navigates it,
   * displacing whatever it held. So: the active pane if it already matches (the
   * one the user is looking at), else the one they used most recently, and only
   * then the leftmost. Anything less lands "open this URL" in a preview the user
   * forgot they had, while the one they were working in sits untouched.
   *
   * Ported verbatim in intent from `use-dock-state`'s `ensureTab`, because that
   * rule is the reason "open this file here" arrives in the pane you are actually
   * looking at.
   */
  const ensurePane = useCallback(
    (kind: PaneKind) => {
      if (!api) return
      // No terminal branch: a terminal is found by the same rule as everything else.
      // `api.panels` includes the bottom row's, and `revealPanel` expands the panel when the
      // pane it picked turns out to live down there — which is all the old special case did,
      // except it also ignored every terminal in a zone and opened a second shell beside one
      // already running.
      const panels = api.panels
      const active = api.activePanel
      if (active && paneKindOf(active) === kind) {
        // Already the pane in focus — though it may be one someone parked at the bottom, in
        // which case the panel still has to come up.
        revealPanel(api, active)
        return
      }

      const byId = new Map(panels.map((p) => [p.api.id, p]))
      const target =
        mru.current
          .map((id) => byId.get(id))
          .find(
            (p): p is IDockviewPanel => p !== undefined && paneKindOf(p) === kind
          ) ?? panels.find((p) => paneKindOf(p) === kind)

      if (target) {
        revealPanel(api, target)
        return
      }
      openPane(kind)
    },
    [api, openPane]
  )

  const openThread = useCallback(
    (threadId: string | null) => {
      if (!api) return

      // A pane already on this thread is the answer — focus it rather than
      // re-addressing another one and ending up with the conversation open twice.
      const existing = threadId
        ? api.panels.find((panel) => {
            const params = paneParamsOf(panel)
            return params?.kind === "chat" && params.threadId === threadId
          })
        : undefined
      if (existing) {
        revealPanel(api, existing)
        return
      }

      const active = api.activePanel
      const byId = new Map(api.panels.map((p) => [p.api.id, p]))
      const target =
        (active && paneKindOf(active) === "chat" ? active : undefined) ??
        mru.current
          .map((id) => byId.get(id))
          .find(
            (p): p is IDockviewPanel => p !== undefined && paneKindOf(p) === "chat"
          ) ??
        api.panels.find((p) => paneKindOf(p) === "chat")

      if (target) {
        target.api.updateParameters({ kind: "chat", threadId })
        revealPanel(api, target)
        return
      }
      openPane("chat", { params: { threadId } })
    },
    [api, openPane]
  )

  /**
   * Memoised, and this is not a micro-optimisation.
   *
   * Six effects in `app-shell` list `layout` in their deps. A fresh object literal
   * here re-ran all six on every shell render — every keystroke in a chat — and the
   * only thing standing between that and duplicate panes was the ref guard each one
   * happens to carry (`seededRef`, `seededThreadFor`, `addressedRoute` and the
   * pending-request hooks' own). Those guards are correct and stay, but they should
   * not be the *reason* nothing breaks.
   *
   * Every member is already stable — `api` is state, the other four are
   * `useCallback` — so this genuinely holds identity between renders rather than
   * just moving the allocation.
   */
  return useMemo(
    () => ({ api, onReady, openPane, ensurePane, openThread }),
    [api, onReady, openPane, ensurePane, openThread]
  )
}

/**
 * The pane kinds a workspace's saved layout holds, in layout order.
 *
 * For the mobile bottom bar, which has no dockview instance to ask — a phone shows
 * one surface at a time, so the pane *layer* never mounts there. Reading the
 * persisted layout is how the bar reflects what you actually opened rather than a
 * fixed list of four, which is what §7 asks for.
 */
export function readLayoutKinds(workspaceId?: string): PaneKind[] {
  const layout = readLayout(workspaceId)
  if (!layout) return []
  const kinds: PaneKind[] = []
  for (const state of Object.values(layout.panels ?? {})) {
    const kind = (state as { params?: PaneParams }).params?.kind
    if (isPaneKind(kind) && !kinds.includes(kind)) kinds.push(kind)
  }
  return kinds
}

/** Whether this workspace has a saved pane layout (or a legacy dock) yet. */
export function hasStoredLayout(workspaceId?: string): boolean {
  try {
    return (
      localStorage.getItem(layoutKey(workspaceId)) !== null ||
      localStorage.getItem(legacyKey(workspaceId)) !== null
    )
  } catch {
    return false
  }
}

/**
 * Start a workspace with a single chat pane, if it has no layout yet.
 *
 * The successor to `seedCollapsedDock`, and the same contract: only when nothing
 * is stored, so a layout the user arranged is never overwritten. Used by the
 * first-run walkthrough — the first conversation should be the whole window, not a
 * chat beside an empty panel.
 */
export function seedChatOnlyLayout(workspaceId: string): void {
  if (hasStoredLayout(workspaceId)) return
  try {
    localStorage.setItem(layoutKey(workspaceId), JSON.stringify(defaultLayout()))
  } catch {
    // Best-effort: without it the workspace just gets the default on first open,
    // which is this same layout.
  }
}
