import { useCallback, useMemo, useState } from "react"

import type { Thread } from "@/api/types"

/** Modifier intent derived from a click: cmd/ctrl toggles, shift ranges. */
export interface SelectMods {
  /** cmd (macOS) / ctrl — toggle a single item in/out of the selection. */
  toggle: boolean
  /** shift — extend the selection from the anchor to the clicked item. */
  range: boolean
}

/**
 * Bulk-selection state for the sidebar's conversation list. Range selection walks
 * an ordered thread list supplied by the caller (the on-screen order), anchored on
 * the last non-range click.
 *
 * Conversations only. Workspaces were selectable too, back when they were rows in
 * this panel — that went with the folder tree: they are rail tiles now, and
 * ⌘-clicking a tile is how you open one in a new window, not how you queue it for
 * deletion. Workspaces are still renamed, cloned and deleted one at a time from a
 * tile's context menu, which is the whole of what the count this rail is built for
 * needs.
 */
export interface SidebarSelection {
  /** Kept as full objects so bulk delete knows each thread's workspace. */
  threads: Map<string, Thread>
  selectThread: (
    thread: Thread,
    mods: SelectMods,
    orderedThreads: Thread[]
  ) => void
  isThreadSelected: (id: string) => boolean
  clear: () => void
  count: number
}

export function useSidebarSelection(): SidebarSelection {
  const [threads, setThreads] = useState<Map<string, Thread>>(new Map())
  const [threadAnchor, setThreadAnchor] = useState<string | null>(null)

  const clear = useCallback(() => {
    setThreads(new Map())
    setThreadAnchor(null)
  }, [])

  const selectThread = useCallback(
    (thread: Thread, mods: SelectMods, orderedThreads: Thread[]) => {
      if (mods.range && threadAnchor) {
        const ids = orderedThreads.map((t) => t.id)
        const a = ids.indexOf(threadAnchor)
        const b = ids.indexOf(thread.id)
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a]
          setThreads((prev) => {
            const next = new Map(prev)
            for (const t of orderedThreads.slice(lo, hi + 1)) next.set(t.id, t)
            return next
          })
          return
        }
      }

      // Range requested but the anchor isn't in this list (e.g. it's in another
      // workspace's list, reached via Activity) — extend the selection with the
      // clicked item rather than discarding everything already selected.
      if (mods.range && threads.size > 0) {
        setThreads((prev) => new Map(prev).set(thread.id, thread))
        setThreadAnchor(thread.id)
        return
      }

      if (mods.toggle) {
        setThreads((prev) => {
          const next = new Map(prev)
          if (next.has(thread.id)) next.delete(thread.id)
          else next.set(thread.id, thread)
          return next
        })
        setThreadAnchor(thread.id)
        return
      }

      setThreads(new Map([[thread.id, thread]]))
      setThreadAnchor(thread.id)
    },
    [threadAnchor, threads]
  )

  const isThreadSelected = useCallback(
    (id: string) => threads.has(id),
    [threads]
  )

  return useMemo(
    () => ({
      threads,
      selectThread,
      isThreadSelected,
      clear,
      count: threads.size,
    }),
    [threads, selectThread, isThreadSelected, clear]
  )
}
