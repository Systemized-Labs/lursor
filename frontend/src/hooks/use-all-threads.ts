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
  /** Yours — the studio and the Assistant are pinned separately in the rail. */
  workspaces: Workspace[]
  /**
   * Every workspace, studio and Assistant included. Anything resolving
   * `is_system` / `is_assistant` itself must read this: {@link workspaces} has
   * already filtered the only rows it looks for, so searching that list for
   * either silently finds nothing.
   */
  allWorkspaces: Workspace[]
  /** Every workspace id, app-owned ones included. */
  workspaceIds: string[]
  /** The system workspace behind the Skill Studio. */
  studio: Workspace | undefined
  /** The app-owned workspace behind the Assistant. */
  assistant: Workspace | undefined
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

  const derived = useMemo(() => {
    const studio = allWorkspaces.find((ws) => ws.is_system)
    const assistant = allWorkspaces.find((ws) => ws.is_assistant)
    return {
      // Both app-owned rows come out of "your projects" and are pinned below
      // the divider instead — they are not things you made, and they take no
      // part in the drag arrangement.
      workspaces: allWorkspaces.filter((ws) => !ws.is_system && !ws.is_assistant),
      allWorkspaces,
      workspaceIds: allWorkspaces.map((ws) => ws.id),
      studio,
      assistant,
    }
  }, [allWorkspaces])

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
