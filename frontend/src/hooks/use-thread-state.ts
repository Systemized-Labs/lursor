import { useCallback } from "react"

import type { Thread } from "@/api/types"
import { useThreadReads } from "@/hooks/use-thread-reads"

/** How a conversation is doing, as far as the sidebar is concerned. */
export interface ThreadState {
  /** The conversation currently open in the main view. */
  isActive: boolean
  /** A background run is working on it right now. */
  running: boolean
  /** A reply landed since it was last opened. */
  unread: boolean
}

/**
 * The one definition of what a conversation's state is.
 *
 * This used to be spelled out at every call site — the Attention filter, the
 * per-workspace badge, the rail's unread count, the Activity filters and each
 * row's own styling. Seven copies of `id !== activeThreadId && !running &&
 * isUnread(...)`, which is exactly the kind of rule that has to agree with itself
 * or the numbers visibly disagree: a badge saying 3 over a list of 2. One of the
 * copies had already drifted. Three of those five surfaces have since been
 * deleted, which argues for the hook rather than against it — the rule outlived
 * them, and so did the `needsAttention` field until the last reader went with
 * Activity.
 *
 * Returns a selector rather than a value so a list can walk itself in one pass.
 */
export function useThreadState(
  activeThreadId: string | null,
  activeRuns: Set<string>
): (thread: Thread) => ThreadState {
  const { isUnread } = useThreadReads()

  return useCallback(
    (thread: Thread) => {
      const isActive = thread.id === activeThreadId
      const running = activeRuns.has(thread.id)
      // The open conversation is being read right now, and a running one already
      // says "working" — neither is a reply you missed.
      const unread =
        !isActive && !running && isUnread(thread.id, thread.updated_at)
      return { isActive, running, unread, needsAttention: running || unread }
    },
    [activeThreadId, activeRuns, isUnread]
  )
}
