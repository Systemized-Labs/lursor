import { useQueries } from "@tanstack/react-query"
import { useEffect, useMemo } from "react"

import { threadKeys, threadsApi } from "@/api/threads"
import {
  markThreadRead,
  seedThreadRead,
  useThreadReads,
} from "@/hooks/use-thread-reads"

interface UnreadContext {
  /** The open conversation — read by definition, however it was reached. */
  activeThreadId: string | null
  /** Conversations with a live run: still working, so not yet "finished unread". */
  runningThreadIds: Set<string>
}

/**
 * How many conversations in each workspace finished while you were looking
 * elsewhere — the per-workspace roll-up of {@link useThreadReads}.
 *
 * A collapsed sidebar folder unmounts the workspace rows inside it, and with
 * them the thread lists that would have flagged an unread reply, so the folder
 * has to know on their behalf. Asking here keeps that answer available whether
 * or not anything is expanded: these queries share React Query's cache with the
 * per-workspace lists, so a mounted row costs no extra request.
 *
 * Reconciling read state lives here for the same reason. A thread first seen
 * inside a shut folder has to be recorded at the `updated_at` it already had,
 * or opening the sidebar would turn every conversation in it unread — and the
 * open conversation has to keep advancing its mark even when its own row isn't
 * mounted to do it.
 */
export function useWorkspaceUnread(
  workspaceIds: string[],
  { activeThreadId, runningThreadIds }: UnreadContext
): Map<string, number> {
  const threadsByWorkspace = useQueries({
    queries: workspaceIds.map((id) => ({
      queryKey: threadKeys.byWorkspace(id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        threadsApi.listByWorkspace(id, signal),
    })),
    combine: (results) => results.map((result) => result.data ?? []),
  })

  const { isUnread } = useThreadReads()

  useEffect(() => {
    for (const threads of threadsByWorkspace) {
      for (const thread of threads) {
        seedThreadRead(thread.id, thread.updated_at)
        if (thread.id === activeThreadId) {
          markThreadRead(thread.id, thread.updated_at)
        }
      }
    }
  }, [threadsByWorkspace, activeThreadId])

  return useMemo(() => {
    const counts = new Map<string, number>()
    workspaceIds.forEach((id, index) => {
      const threads = threadsByWorkspace[index] ?? []
      counts.set(
        id,
        threads.filter(
          (thread) =>
            thread.id !== activeThreadId &&
            !runningThreadIds.has(thread.id) &&
            isUnread(thread.id, thread.updated_at)
        ).length
      )
    })
    return counts
  }, [
    workspaceIds,
    threadsByWorkspace,
    isUnread,
    activeThreadId,
    runningThreadIds,
  ])
}
