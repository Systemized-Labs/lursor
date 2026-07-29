import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type { Workspace } from "@/api/types"

const STORAGE_KEY = "lursor:workspace-order"

function load(): string[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === "string")
  } catch {
    return []
  }
}

export interface WorkspaceOrder {
  /** The rail's workspaces, in the order their tiles should appear. */
  ordered: Workspace[]
  /** Move the tile at `from` to `to`, and remember it. */
  move: (from: number, to: number) => void
}

/**
 * The rail's tile order: yours if you've dragged one, creation order otherwise.
 *
 * Stability is the whole point, and it is worth being explicit about why this
 * isn't sorted by recency. A rail you switch through dozens of times a day is
 * navigated by position — you reach for "the second tile", and ⌘2 has to mean
 * the same workspace every time. Recency ordering would move your targets
 * around precisely because you use them, so the more you switched the less the
 * rail could be learned. Recency lives in `use-workspace-visits`, where it
 * drives only the MRU switch.
 *
 * The stored list is a *preference*, not the source of truth: unknown ids are
 * dropped and workspaces missing from it fall in after the ones it names, so a
 * new workspace appears at the end and a deleted one leaves no gap.
 */
export function useWorkspaceOrder(workspaces: Workspace[]): WorkspaceOrder {
  const [order, setOrder] = useState<string[]>(load)

  // Skip the first run: it would write back exactly what `load()` just read.
  const loaded = useRef(false)
  useEffect(() => {
    if (!loaded.current) {
      loaded.current = true
      return
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(order))
    } catch {
      // Ignore quota / disabled-storage errors — tile order is best-effort.
    }
  }, [order])

  const ordered = useMemo(() => {
    const byId = new Map(workspaces.map((ws) => [ws.id, ws]))
    const seen = new Set<string>()
    const out: Workspace[] = []
    for (const id of order) {
      const ws = byId.get(id)
      if (ws && !seen.has(id)) {
        seen.add(id)
        out.push(ws)
      }
    }
    for (const ws of workspaces) if (!seen.has(ws.id)) out.push(ws)
    return out
  }, [workspaces, order])

  // Persist the *resolved* order rather than splicing the stored one: the stored
  // list can be stale or partial, so reordering what's on screen is the only
  // thing guaranteed to match what was dragged.
  const move = useCallback(
    (from: number, to: number) => {
      if (from === to) return
      const ids = ordered.map((ws) => ws.id)
      if (from < 0 || from >= ids.length || to < 0 || to >= ids.length) return
      const [moved] = ids.splice(from, 1)
      ids.splice(to, 0, moved)
      setOrder(ids)
    },
    [ordered]
  )

  return useMemo(() => ({ ordered, move }), [ordered, move])
}
