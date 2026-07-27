import { useCallback, useEffect, useRef, useState } from "react"

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
}

/** Persisted shape — kinds + active index only, so runtime ids never leak. */
interface StoredDock {
  collapsed: boolean
  tabs: DockKind[]
  activeIndex: number
}

// Tab ids only need to be unique within a session; a module counter keeps them
// distinct even across workspace reloads (restored tabs get fresh ids).
let tabSeq = 0
const nextTabId = () => `dock-tab-${++tabSeq}`

const STORAGE_PREFIX = "lursor:dock:"
const keyFor = (workspaceId?: string) => `${STORAGE_PREFIX}${workspaceId ?? "_global"}`

function readDockState(workspaceId?: string): DockState {
  const empty: DockState = { collapsed: false, tabs: [], activeId: null }
  try {
    const raw = localStorage.getItem(keyFor(workspaceId))
    if (!raw) return empty
    const stored = JSON.parse(raw) as Partial<StoredDock>
    const kinds = Array.isArray(stored.tabs)
      ? stored.tabs.filter((k): k is DockKind => DOCK_KINDS.includes(k as DockKind))
      : []
    const tabs = kinds.map((kind) => ({ id: nextTabId(), kind }))
    const idx = typeof stored.activeIndex === "number" ? stored.activeIndex : tabs.length - 1
    const activeId = tabs[idx]?.id ?? tabs[tabs.length - 1]?.id ?? null
    return { collapsed: !!stored.collapsed, tabs, activeId }
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
      tabs: state.tabs.map((t) => t.kind),
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

  const openTab = useCallback(
    (kind: DockKind) =>
      update((prev) => {
        const tab: DockTab = { id: nextTabId(), kind }
        return { ...prev, tabs: [...prev.tabs, tab], activeId: tab.id }
      }),
    [update]
  )

  /**
   * Reveal a panel of `kind`: focus the existing one, or add it if absent.
   *
   * Deliberately decided inside the updater rather than from `tabs` in the
   * caller's closure. On the render where the active workspace changes, that
   * closure still holds the *previous* workspace's tabs (the reload effect has
   * not committed yet), so a caller checking `tabs.some(...)` itself would add
   * a second tab of the same kind. That matters beyond tidiness: a duplicate
   * file tab means two FileViewers, and `consumePendingFile` hands the pending
   * "open this file" request to whichever mounts first — leaving the tab the
   * user is looking at empty.
   */
  const ensureTab = useCallback(
    (kind: DockKind) =>
      update((prev) => {
        const existing = prev.tabs.find((t) => t.kind === kind)
        if (existing) return { ...prev, activeId: existing.id }
        const tab: DockTab = { id: nextTabId(), kind }
        return { ...prev, tabs: [...prev.tabs, tab], activeId: tab.id }
      }),
    [update]
  )

  const closeTab = useCallback(
    (id: string) =>
      update((prev) => {
        const tabs = prev.tabs.filter((t) => t.id !== id)
        const activeId =
          prev.activeId === id
            ? tabs[tabs.length - 1]?.id ?? null
            : prev.activeId
        return { ...prev, tabs, activeId }
      }),
    [update]
  )

  const selectTab = useCallback(
    (id: string) => update((prev) => ({ ...prev, activeId: id })),
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
