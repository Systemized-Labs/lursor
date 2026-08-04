import { useCallback, useEffect, useRef, useState } from "react"
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
  type PaneKind,
  type PaneParams,
} from "@/components/panes/pane-kinds"
import { clearTabStorage } from "@/lib/tab-storage"

const LAYOUT_PREFIX = "lursor:layout:"
/** The right dock's old per-workspace key, read once for the migration. */
const LEGACY_PREFIX = "lursor:dock:"

const layoutKey = (workspaceId?: string) =>
  `${LAYOUT_PREFIX}${workspaceId ?? "_global"}`
const legacyKey = (workspaceId?: string) =>
  `${LEGACY_PREFIX}${workspaceId ?? "_global"}`

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
    if (raw) return JSON.parse(raw) as SerializedDockview
  } catch {
    // Corrupt or unreadable: fall through to the migration, then the default.
  }
  return migrateLegacy(workspaceId)
}

export interface PaneLayout {
  /** Set once dockview is ready. */
  api: DockviewApi | null
  onReady: (api: DockviewApi) => void
  /**
   * Add a pane of `kind` and focus it — always a new one, even when one of that
   * kind is already open. Two previews on different ports, or two chats on two
   * threads, are legitimate layouts; each carries its own state under its own id.
   */
  openPane: (
    kind: PaneKind,
    opts?: { params?: Partial<PaneParams>; groupId?: string }
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

  const write = useCallback((target: DockviewApi, ws?: string) => {
    try {
      localStorage.setItem(layoutKey(ws), JSON.stringify(target.toJSON()))
    } catch {
      // Ignore quota / disabled-storage errors — persistence is best-effort.
    }
  }, [])

  const load = useCallback(
    (target: DockviewApi, ws?: string) => {
      const layout = readLayout(ws) ?? defaultLayout()
      try {
        target.fromJSON(layout)
      } catch {
        // A layout dockview refuses (a hand-edited key, a shape from a future
        // version) must not leave an empty window with no way back.
        target.clear()
        target.fromJSON(defaultLayout())
      }
      loadedFor.current = ws
      mru.current = target.activePanel ? [target.activePanel.api.id] : []
      // Commit immediately rather than waiting for the first change. Dockview only
      // fires `onDidLayoutChange` when something *changes*, so a migrated or
      // defaulted layout would otherwise never be written — and would be re-derived
      // from the legacy key on every launch, handing the chat pane a new id each
      // time and losing whatever it had stored.
      write(target, ws)
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
      api.onDidLayoutChange(persist),
      api.onDidActivePanelChange((event) => {
        if (!event.panel) return
        const id = event.panel.api.id
        mru.current = [id, ...mru.current.filter((x) => x !== id)]
      }),
      // A closed pane is gone for good, so drop whatever it persisted rather
      // than leaving an orphaned `lursor:tab:<id>:*` entry behind.
      api.onDidRemovePanel((panel) => {
        clearTabStorage(panel.api.id)
        mru.current = mru.current.filter((x) => x !== panel.api.id)
      }),
    ]
    return () => subs.forEach((sub) => sub.dispose())
  }, [api, workspaceId, write])

  const openPane = useCallback(
    (
      kind: PaneKind,
      opts?: { params?: Partial<PaneParams>; groupId?: string }
    ) => {
      if (!api) return
      api.addPanel({
        id: newPaneId(),
        component: kind,
        tabComponent: "pane",
        title: PANE_KINDS[kind].title,
        renderer: PANE_KINDS[kind].renderer,
        params: { kind, ...opts?.params } satisfies PaneParams,
        // A `+` on a zone's strip means "here", not "wherever dockview decides".
        ...(opts?.groupId
          ? {
              floating: false as const,
              position: { referenceGroup: opts.groupId, direction: "within" as const },
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
      const panels = api.panels
      const kindOf = (panel: IDockviewPanel) =>
        (panel.params as PaneParams | undefined)?.kind
      const active = api.activePanel
      if (active && kindOf(active) === kind) return

      const byId = new Map(panels.map((p) => [p.api.id, p]))
      const target =
        mru.current
          .map((id) => byId.get(id))
          .find((p): p is IDockviewPanel => p !== undefined && kindOf(p) === kind) ??
        panels.find((p) => kindOf(p) === kind)

      if (target) {
        target.api.setActive()
        return
      }
      openPane(kind)
    },
    [api, openPane]
  )

  const openThread = useCallback(
    (threadId: string | null) => {
      if (!api) return
      const kindOf = (panel: IDockviewPanel) =>
        (panel.params as PaneParams | undefined)?.kind

      // A pane already on this thread is the answer — focus it rather than
      // re-addressing another one and ending up with the conversation open twice.
      const existing = threadId
        ? api.panels.find(
            (panel) =>
              kindOf(panel) === "chat" &&
              (panel.params as PaneParams | undefined)?.threadId === threadId
          )
        : undefined
      if (existing) {
        existing.api.setActive()
        return
      }

      const active = api.activePanel
      const byId = new Map(api.panels.map((p) => [p.api.id, p]))
      const target =
        (active && kindOf(active) === "chat" ? active : undefined) ??
        mru.current
          .map((id) => byId.get(id))
          .find(
            (p): p is IDockviewPanel => p !== undefined && kindOf(p) === "chat"
          ) ??
        api.panels.find((p) => kindOf(p) === "chat")

      if (target) {
        target.api.updateParameters({ kind: "chat", threadId })
        target.api.setActive()
        return
      }
      openPane("chat", { params: { threadId } })
    },
    [api, openPane]
  )

  return { api, onReady, openPane, ensurePane, openThread }
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
