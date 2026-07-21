import { useSyncExternalStore } from "react"

/**
 * Tracks when each workspace was last opened so the sidebar can surface the
 * most recently used ones first. Persisted per-device in localStorage (this is
 * a local single-user app, so a client-side store is sufficient and avoids a
 * backend migration). Backed by an in-memory cache + subscriber list so React
 * views re-sort reactively the moment a workspace is touched.
 */

const STORAGE_KEY = "workspace-recency"

/** Map of workspace id -> epoch millis of last open. */
type RecencyMap = Record<string, number>

let cache: RecencyMap | null = null
const listeners = new Set<() => void>()

function read(): RecencyMap {
  if (cache) return cache
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : {}
    cache =
      parsed && typeof parsed === "object" ? (parsed as RecencyMap) : {}
  } catch {
    cache = {}
  }
  return cache
}

/** Record that a workspace was just opened, bumping it to the top. */
export function touchWorkspace(id: string): void {
  const next: RecencyMap = { ...read(), [id]: Date.now() }
  cache = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Ignore quota/availability errors — recency is a best-effort nicety.
  }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Reactive read of the recency map; re-renders subscribers on {@link touchWorkspace}. */
export function useWorkspaceRecency(): RecencyMap {
  return useSyncExternalStore(subscribe, read, read)
}
