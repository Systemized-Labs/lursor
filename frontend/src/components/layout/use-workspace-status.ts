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
 * Per-workspace status for the project rows, rolled up from every conversation
 * in one pass.
 *
 * Rolled up here rather than per row because the alternative is each row
 * filtering the whole cross-workspace list for itself — N passes over the same
 * array on every poll, and `use-thread-state`'s selector is the kind of thing
 * that has to agree with itself: a folder's rolled-up count has to match the
 * sessions under the projects inside it, or the badge and the rows disagree in
 * plain sight.
 *
 * `running` is what a project row shows. `unread` now only reaches a *folder*
 * header, because a project's sessions are listed directly beneath it carrying
 * their own marks — a number restating them was noise — while a shut folder hides
 * its projects entirely and has nothing else to say it with.
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
