import { useCallback, useEffect, useRef, useState } from "react"

import { clearTabStorage } from "@/lib/tab-storage"

/** Panel kinds the right dock can host. */
export type DockKind = "changes" | "file" | "preview" | "terminal"

export const DOCK_KINDS: DockKind[] = [
  "changes",
  "file",
  "preview",
  "terminal",
]

export interface DockTab {
  id: string
  kind: DockKind
}

/** Runtime dock state for a single workspace. */
interface DockState {
  collapsed: boolean
  tabs: DockTab[]
  activeId: string | null
  /** Ids in focus order, most recent first — picks the target in {@link
   *  useDockState.ensureTab} when a kind is open more than once. Session-only:
   *  a reload starts it from the restored active tab. */
  mru: string[]
}

/** Focus a tab, recording it as the most recently used. */
function focusTab(state: DockState, id: string): DockState {
  return {
    ...state,
    activeId: id,
    mru: [id, ...state.mru.filter((x) => x !== id)],
  }
}

/** Persisted shape. Tab ids are persisted too (not just kinds) because panels
 *  key their own state off them — see {@link clearTabStorage} — so a reload has
 *  to restore the same id to restore, say, a preview's URL. */
interface StoredDock {
  collapsed: boolean
  tabs: DockTab[]
  activeIndex: number
}

/**
 * A globally unique tab id. Unique across workspaces and across reloads, not
 * just within a session: per-tab storage keys are global, so a recycled id would
 * hand a new tab a dead one's state.
 */
function newTabId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `t-${crypto.randomUUID()}`
    }
  } catch {
    // Fall through to the Math.random id below.
  }
  return `t-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

const isDockKind = (v: unknown): v is DockKind =>
  typeof v === "string" && DOCK_KINDS.includes(v as DockKind)

/**
 * Parse persisted tabs, tolerating the pre-multi-tab format (a bare `DockKind[]`)
 * and any corruption: unknown kinds are dropped, missing or repeated ids get
 * fresh ones (a repeat would collide as a React key and share panel state).
 */
function parseStoredTabs(raw: unknown): DockTab[] {
  if (!Array.isArray(raw)) return []
  const tabs: DockTab[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const kind = typeof entry === "string" ? entry : (entry as DockTab | null)?.kind
    if (!isDockKind(kind)) continue
    const stored = typeof entry === "string" ? undefined : (entry as DockTab).id
    const id =
      typeof stored === "string" && stored && !seen.has(stored) ? stored : newTabId()
    seen.add(id)
    tabs.push({ id, kind })
  }
  return tabs
}

const STORAGE_PREFIX = "lursor:dock:"
const keyFor = (workspaceId?: string) => `${STORAGE_PREFIX}${workspaceId ?? "_global"}`

function readDockState(workspaceId?: string): DockState {
  const empty: DockState = { collapsed: false, tabs: [], activeId: null, mru: [] }
  try {
    const raw = localStorage.getItem(keyFor(workspaceId))
    if (!raw) return empty
    const stored = JSON.parse(raw) as Partial<StoredDock>
    const tabs = parseStoredTabs(stored.tabs)
    const idx = typeof stored.activeIndex === "number" ? stored.activeIndex : tabs.length - 1
    const activeId = tabs[idx]?.id ?? tabs[tabs.length - 1]?.id ?? null
    return {
      collapsed: !!stored.collapsed,
      tabs,
      activeId,
      mru: activeId ? [activeId] : [],
    }
  } catch {
    return empty
  }
}

/**
 * Whether this workspace has a saved layout yet. Lets a caller seed a sensible
 * first-visit dock (see the Skill Studio in {@link AppShell}) without ever
 * overriding a layout the user has arranged.
 */
export function hasStoredDockState(workspaceId?: string): boolean {
  try {
    return localStorage.getItem(keyFor(workspaceId)) !== null
  } catch {
    return false
  }
}

function writeDockState(workspaceId: string | undefined, state: DockState) {
  try {
    const stored: StoredDock = {
      collapsed: state.collapsed,
      tabs: state.tabs.map((t) => ({ id: t.id, kind: t.kind })),
      activeIndex: state.tabs.findIndex((t) => t.id === state.activeId),
    }
    localStorage.setItem(keyFor(workspaceId), JSON.stringify(stored))
  } catch {
    // Ignore quota / disabled-storage errors — persistence is best-effort.
  }
}

/**
 * Right-dock state (collapsed + open tabs + active tab) persisted per workspace
 * in localStorage. Switching workspaces loads that workspace's saved layout;
 * refreshing the page restores it. Every mutation writes through to storage, so
 * a closed dock stays closed and open panels reopen on reload.
 */
export function useDockState(workspaceId?: string) {
  const [state, setState] = useState<DockState>(() => readDockState(workspaceId))

  // Reload the saved layout when the active workspace changes (skip the initial
  // mount, which the lazy initializer above already handled).
  const wsRef = useRef(workspaceId)
  useEffect(() => {
    if (wsRef.current === workspaceId) return
    wsRef.current = workspaceId
    setState(readDockState(workspaceId))
  }, [workspaceId])

  // Persist through user-driven mutations only, always to the current workspace
  // — never on a workspace switch, so a load can't overwrite a neighbour's key.
  const update = useCallback(
    (updater: (prev: DockState) => DockState) => {
      setState((prev) => {
        const next = updater(prev)
        writeDockState(workspaceId, next)
        return next
      })
    },
    [workspaceId]
  )

  const setCollapsed = useCallback(
    (collapsed: boolean) => update((prev) => ({ ...prev, collapsed })),
    [update]
  )

  /**
   * Add a panel of `kind` and focus it — always a new tab, even when one of that
   * kind is already open. Two previews pointed at different ports, or two
   * editors side by side in split view, are legitimate layouts; each tab carries
   * its own state (keyed by its id) so the copies don't interfere.
   */
  const openTab = useCallback(
    (kind: DockKind) =>
      update((prev) => {
        const tab: DockTab = { id: newTabId(), kind }
        return focusTab({ ...prev, tabs: [...prev.tabs, tab] }, tab.id)
      }),
    [update]
  )

  /**
   * Reveal a panel of `kind` for a request arriving from elsewhere in the app
   * (an "open this file" from the command palette, say): focus an existing tab
   * of that kind, or add one if there is none.
   *
   * With duplicates allowed, *which* one matters — the request navigates it,
   * displacing whatever it held. So: the active tab if it already matches (the
   * panel the user is looking at), else the one they used most recently, and
   * only then the leftmost. Anything less lands "open this URL" in a preview the
   * user forgot they had, while the one they were working in sits untouched.
   *
   * Deliberately decided inside the updater rather than from `tabs` in the
   * caller's closure. On the render where the active workspace changes, that
   * closure still holds the *previous* workspace's tabs (the reload effect has
   * not committed yet), so a caller checking `tabs.some(...)` itself would add a
   * stray tab every time.
   */
  const ensureTab = useCallback(
    (kind: DockKind) =>
      update((prev) => {
        const byId = new Map(prev.tabs.map((t) => [t.id, t]))
        const active = byId.get(prev.activeId ?? "")
        if (active?.kind === kind) return prev
        const target =
          prev.mru.map((id) => byId.get(id)).find((t) => t?.kind === kind) ??
          prev.tabs.find((t) => t.kind === kind)
        if (target) return focusTab(prev, target.id)
        const tab: DockTab = { id: newTabId(), kind }
        return focusTab({ ...prev, tabs: [...prev.tabs, tab] }, tab.id)
      }),
    [update]
  )

  const closeTab = useCallback(
    (id: string) =>
      update((prev) => {
        const tabs = prev.tabs.filter((t) => t.id !== id)
        // The tab is gone for good, so drop whatever its panel persisted (a
        // preview URL, …) instead of leaving an orphaned entry behind.
        if (tabs.length !== prev.tabs.length) clearTabStorage(id)
        const mru = prev.mru.filter((x) => x !== id)
        // Closing the active tab falls back to the one used before it, not the
        // rightmost — same instinct as a browser closing a tab you switched to.
        const activeId =
          prev.activeId === id
            ? mru.find((x) => tabs.some((t) => t.id === x)) ??
              tabs[tabs.length - 1]?.id ??
              null
            : prev.activeId
        return { ...prev, tabs, activeId, mru }
      }),
    [update]
  )

  const selectTab = useCallback(
    (id: string) => update((prev) => focusTab(prev, id)),
    [update]
  )

  return {
    collapsed: state.collapsed,
    tabs: state.tabs,
    activeId: state.activeId,
    setCollapsed,
    openTab,
    ensureTab,
    closeTab,
    selectTab,
  }
}
