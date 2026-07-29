import { useMemo } from "react"

import { useAllThreadsQuery } from "@/api/threads"
import { useWorkspaces } from "@/api/workspaces"
import type { Thread, Workspace } from "@/api/types"

export interface AllThreads {
  /** Every conversation, every workspace, newest activity first. */
  threads: Thread[]
  /** The same threads bucketed by workspace, each bucket still newest-first. */
  byWorkspace: Map<string, Thread[]>
  /** Workspace name for a thread's `workspace_id`; "" if it hasn't loaded. */
  workspaceName: (workspaceId: string) => string
  /** Yours — the system workspace is a rail destination, not a folder. */
  workspaces: Workspace[]
  /** Every workspace id including the studio's. */
  workspaceIds: string[]
  /** The system workspace behind the Skill Studio. */
  studioId: string | undefined
  isLoading: boolean
  workspacesLoading: boolean
}

/**
 * The cross-workspace conversation list, shared by every surface that needs
 * one: the sidebar's panels and the command palette.
 *
 * `GET /threads` with no `workspace_id` already returns all of them ordered by
 * recency, so this is a single request rather than a fan-out over N workspaces
 * — and `byWorkspace` means an expanded folder can slice this list instead of
 * fetching its own copy of rows we are already holding.
 *
 * Note it hands back the threads react-query gave it, untouched. Decorating
 * each one with its workspace name (the obvious move) would give every row a
 * new object identity whenever the *workspace* list changed — a rename, a
 * create, any refetch — defeating structural sharing for data that didn't
 * change. The name is a lookup instead, resolved by the two surfaces that show
 * it.
 */
export function useAllThreads(): AllThreads {
  const threadsQuery = useAllThreadsQuery()
  const workspacesQuery = useWorkspaces()

  const allWorkspaces = useMemo(
    () => workspacesQuery.data ?? [],
    [workspacesQuery.data]
  )
  const threads = useMemo(() => threadsQuery.data ?? [], [threadsQuery.data])

  const byWorkspace = useMemo(() => {
    const buckets = new Map<string, Thread[]>()
    for (const thread of threads) {
      const bucket = buckets.get(thread.workspace_id)
      if (bucket) bucket.push(thread)
      else buckets.set(thread.workspace_id, [thread])
    }
    return buckets
  }, [threads])

  const nameById = useMemo(
    () => new Map(allWorkspaces.map((ws) => [ws.id, ws.name])),
    [allWorkspaces]
  )

  const derived = useMemo(
    () => ({
      workspaces: allWorkspaces.filter((ws) => !ws.is_system),
      workspaceIds: allWorkspaces.map((ws) => ws.id),
      studioId: allWorkspaces.find((ws) => ws.is_system)?.id,
    }),
    [allWorkspaces]
  )

  const workspaceName = useMemo(
    () => (workspaceId: string) => nameById.get(workspaceId) ?? "",
    [nameById]
  )

  return {
    threads,
    byWorkspace,
    workspaceName,
    ...derived,
    isLoading: threadsQuery.isLoading,
    workspacesLoading: workspacesQuery.isLoading,
  }
}
