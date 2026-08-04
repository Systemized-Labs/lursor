import { useCallback, useEffect, useState } from "react"

/** Pinned conversation ids. A device preference, like the sidebar's width. */
const STORAGE_KEY = "lursor:pins"

/**
 * Which conversations are pinned to the top of the sidebar.
 *
 * Client-side, deliberately, for v1: there is no `Thread.pinned` column, and
 * adding one would be a migration plus an endpoint in service of a feature whose
 * shape is not settled yet. Getting it wrong costs a list order, not data. If
 * pins need to survive a machine change — the app is reachable over the LAN, so
 * that is a real scenario — the column can follow and this hook becomes its
 * cache.
 *
 * Unlike the workspace tree's folders, which *are* server-held for exactly that
 * reason: a group is a thing you made and named, and one that existed on the
 * laptop and not the phone would be a filing system that forgets. A pin is a
 * bookmark on one screen, which is a weaker claim.
 */
export interface Pins {
  ids: Set<string>
  has: (threadId: string) => boolean
  toggle: (threadId: string) => void
  /** Drop pins for conversations that no longer exist. */
  prune: (knownIds: string[]) => void
}

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

export function usePins(): Pins {
  const [ids, setIds] = useState<Set<string>>(load)

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]))
    } catch {
      // Ignore quota / disabled-storage errors — pins are best-effort.
    }
  }, [ids])

  const has = useCallback((threadId: string) => ids.has(threadId), [ids])

  const toggle = useCallback((threadId: string) => {
    setIds((prev) => {
      const next = new Set(prev)
      if (!next.delete(threadId)) next.add(threadId)
      return next
    })
  }, [])

  /**
   * Waits for a non-empty list: the first render, before the threads query
   * resolves, would otherwise wipe every pin. Same guard `use-workspace-icons`
   * needs for the same reason.
   */
  const prune = useCallback((knownIds: string[]) => {
    if (knownIds.length === 0) return
    const known = new Set(knownIds)
    setIds((prev) => {
      let dropped = false
      const next = new Set<string>()
      for (const id of prev) {
        if (known.has(id)) next.add(id)
        else dropped = true
      }
      return dropped ? next : prev
    })
  }, [])

  return { ids, has, toggle, prune }
}
