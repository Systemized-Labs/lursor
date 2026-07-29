import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  mruOrder,
  readVisits,
  writeVisits,
  type Visits,
} from "@/lib/workspace-resume"

export interface WorkspaceVisits {
  /** The raw record, for `resumeHref`. */
  visits: Visits
  /** Known workspace ids, most recently visited first; unvisited ones omitted. */
  mru: string[]
  /** Note that you are in this workspace, on this conversation. */
  record: (workspaceId: string, threadId: string | null) => void
}

/**
 * Per-workspace resume memory — the conversation you had open, and how recently
 * you were there.
 *
 * This is what makes switching lossless. Peer to `use-dock-state`, which already
 * remembers each workspace's dock layout by the same trick, so a switch now
 * restores both halves of where you were.
 *
 * Deliberately *not* the rail's ordering. Tiles sit in a stable order so their
 * positions become muscle memory (see `use-workspace-order`); recency drives only
 * the ⌘-tab-style MRU switch, which wants the opposite of stability.
 *
 * `knownIds` prunes workspaces that no longer exist, and waits for a non-empty
 * list so the first render — before the workspaces query resolves — doesn't wipe
 * the record.
 */
export function useWorkspaceVisits(knownIds: string[]): WorkspaceVisits {
  const [visits, setVisits] = useState<Visits>(readVisits)

  // Skip the first run: it would write back exactly what `readVisits()` just read.
  const loaded = useRef(false)
  useEffect(() => {
    if (!loaded.current) {
      loaded.current = true
      return
    }
    writeVisits(visits)
  }, [visits])

  useEffect(() => {
    if (knownIds.length === 0) return
    const known = new Set(knownIds)
    setVisits((prev) => {
      const next: Visits = {}
      let dropped = false
      for (const [id, visit] of Object.entries(prev)) {
        if (known.has(id)) next[id] = visit
        else dropped = true
      }
      return dropped ? next : prev
    })
  }, [knownIds])

  const record = useCallback((workspaceId: string, threadId: string | null) => {
    setVisits((prev) => {
      const current = prev[workspaceId]
      // Re-recording the same conversation still refreshes `at` — that is what
      // keeps the MRU chain honest while you sit in one workspace — but only
      // once a second, so a burst of re-renders isn't a burst of writes.
      const at = Date.now()
      if (current?.threadId === threadId && at - current.at < 1000) return prev
      return { ...prev, [workspaceId]: { threadId, at } }
    })
  }, [])

  const mru = useMemo(() => mruOrder(visits), [visits])

  return useMemo(() => ({ visits, mru, record }), [visits, mru, record])
}
