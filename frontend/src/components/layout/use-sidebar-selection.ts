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
 * Bulk-selection state for the sidebar. Workspaces and conversations are
 * selected in mutually exclusive sets — picking one kind clears the other so a
 * bulk action always targets a single kind. Range selection walks an ordered id
 * list supplied by the caller (the on-screen order), anchored on the last
 * non-range click.
 */
export interface SidebarSelection {
  workspaceIds: Set<string>
  /** Kept as full objects so bulk delete knows each thread's workspace. */
  threads: Map<string, Thread>
  selectWorkspace: (id: string, mods: SelectMods, orderedIds: string[]) => void
  selectThread: (
    thread: Thread,
    mods: SelectMods,
    orderedThreads: Thread[]
  ) => void
  isWorkspaceSelected: (id: string) => boolean
  isThreadSelected: (id: string) => boolean
  clear: () => void
  count: number
  kind: "workspace" | "thread" | null
}

export function useSidebarSelection(): SidebarSelection {
  const [workspaceIds, setWorkspaceIds] = useState<Set<string>>(new Set())
  const [threads, setThreads] = useState<Map<string, Thread>>(new Map())
  const [wsAnchor, setWsAnchor] = useState<string | null>(null)
  const [threadAnchor, setThreadAnchor] = useState<string | null>(null)

  const clear = useCallback(() => {
    setWorkspaceIds(new Set())
    setThreads(new Map())
    setWsAnchor(null)
    setThreadAnchor(null)
  }, [])

  const selectWorkspace = useCallback(
    (id: string, mods: SelectMods, orderedIds: string[]) => {
      // Selecting a workspace abandons any conversation selection.
      setThreads(new Map())
      setThreadAnchor(null)

      if (mods.range && wsAnchor) {
        const a = orderedIds.indexOf(wsAnchor)
        const b = orderedIds.indexOf(id)
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a]
          setWorkspaceIds(new Set(orderedIds.slice(lo, hi + 1)))
          return
        }
      }

      if (mods.toggle) {
        setWorkspaceIds((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
        setWsAnchor(id)
        return
      }

      // Plain modifier-less selection (e.g. shift with no anchor): single-pick.
      setWorkspaceIds(new Set([id]))
      setWsAnchor(id)
    },
    [wsAnchor]
  )

  const selectThread = useCallback(
    (thread: Thread, mods: SelectMods, orderedThreads: Thread[]) => {
      // Selecting a conversation abandons any workspace selection.
      setWorkspaceIds(new Set())
      setWsAnchor(null)

      if (mods.range && threadAnchor) {
        const ids = orderedThreads.map((t) => t.id)
        const a = ids.indexOf(threadAnchor)
        const b = ids.indexOf(thread.id)
        // Range only applies within the same workspace's ordered list.
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
    [threadAnchor]
  )

  const isWorkspaceSelected = useCallback(
    (id: string) => workspaceIds.has(id),
    [workspaceIds]
  )
  const isThreadSelected = useCallback(
    (id: string) => threads.has(id),
    [threads]
  )

  const kind: "workspace" | "thread" | null =
    workspaceIds.size > 0 ? "workspace" : threads.size > 0 ? "thread" : null

  return useMemo(
    () => ({
      workspaceIds,
      threads,
      selectWorkspace,
      selectThread,
      isWorkspaceSelected,
      isThreadSelected,
      clear,
      count: workspaceIds.size + threads.size,
      kind,
    }),
    [
      workspaceIds,
      threads,
      selectWorkspace,
      selectThread,
      isWorkspaceSelected,
      isThreadSelected,
      clear,
      kind,
    ]
  )
}
