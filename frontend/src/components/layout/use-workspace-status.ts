import { useMemo } from "react"

import type { Thread } from "@/api/types"
import type { ThreadState } from "@/hooks/use-thread-state"

/** What a workspace's tile needs to show about it. */
export interface WorkspaceStatusValue {
  /** An agent is working in this workspace right now. */
  running: boolean
  /** Replies that landed here and you haven't read. */
  unread: number
}

export type WorkspaceStatus = (workspaceId: string) => WorkspaceStatusValue

const IDLE: WorkspaceStatusValue = { running: false, unread: 0 }

/**
 * Per-workspace status for the rail, rolled up from every conversation in one
 * pass.
 *
 * Rolled up here rather than per tile because the alternative is each tile
 * filtering the whole cross-workspace list for itself — N passes over the same
 * array on every poll, and `use-thread-state`'s selector is the kind of thing
 * that has to agree with itself: the Activity badge counts unread threads across
 * all workspaces, and the sum of the tiles has to be that number or the two
 * visibly disagree.
 */
export function useWorkspaceStatus(
  threads: Thread[],
  threadState: (thread: Thread) => ThreadState
): WorkspaceStatus {
  const byWorkspace = useMemo(() => {
    const map = new Map<string, WorkspaceStatusValue>()
    for (const thread of threads) {
      const { running, unread } = threadState(thread)
      if (!running && !unread) continue
      const current = map.get(thread.workspace_id)
      if (current) {
        current.running = current.running || running
        current.unread += unread ? 1 : 0
      } else {
        map.set(thread.workspace_id, { running, unread: unread ? 1 : 0 })
      }
    }
    return map
  }, [threads, threadState])

  return useMemo(
    () => (workspaceId: string) => byWorkspace.get(workspaceId) ?? IDLE,
    [byWorkspace]
  )
}
