import { useCallback, useEffect, useMemo, useRef, useState } from "react"

const STORAGE_KEY = "sidebar:open-workspaces"

function load(): Set<string> {
  if (typeof window === "undefined") return new Set()
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((id): id is string => typeof id === "string"))
  } catch {
    return new Set()
  }
}

export interface OpenWorkspaces {
  isOpen: (id: string) => boolean
  toggle: (id: string) => void
  open: (id: string) => void
}

/**
 * Which workspace sections are expanded, persisted across reloads (the sidebar
 * width already is, so collapsing every folder on refresh read as a bug).
 *
 * `knownIds` prunes the stored set: a deleted workspace must not leak an entry
 * forever. Pruning waits for a non-empty list so the first render — before the
 * workspaces query resolves — doesn't wipe everything.
 *
 * `activeId` auto-expands the workspace you navigate into, but only on the way
 * *in*: collapsing the one you're already inside has to stick, which a plain
 * `activeId === id` rule would undo on the next render.
 */
export function useOpenWorkspaces(
  knownIds: string[],
  activeId: string | undefined
): OpenWorkspaces {
  const [ids, setIds] = useState<Set<string>>(load)

  // Skip the first run: it would write back exactly what `load()` just read,
  // one synchronous storage write per app start for no change.
  const loaded = useRef(false)
  useEffect(() => {
    if (!loaded.current) {
      loaded.current = true
      return
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]))
    } catch {
      // Ignore quota / disabled-storage errors — open state is best-effort.
    }
  }, [ids])

  useEffect(() => {
    if (knownIds.length === 0) return
    const known = new Set(knownIds)
    setIds((prev) => {
      const next = new Set<string>()
      for (const id of prev) if (known.has(id)) next.add(id)
      return next.size === prev.size ? prev : next
    })
  }, [knownIds])

  const open = useCallback((id: string) => {
    setIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
  }, [])

  const toggle = useCallback((id: string) => {
    setIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  // `undefined` here means "no workspace has been observed yet", so a cold load
  // straight into a workspace URL still counts as entering it.
  const prevActive = useRef<string | undefined>(undefined)
  useEffect(() => {
    const entered = prevActive.current !== activeId
    prevActive.current = activeId
    if (entered && activeId) open(activeId)
  }, [activeId, open])

  const isOpen = useCallback((id: string) => ids.has(id), [ids])

  return useMemo(() => ({ isOpen, toggle, open }), [isOpen, toggle, open])
}
