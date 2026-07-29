import type { Thread } from "@/api/types"
import type { SidebarSelection } from "@/components/layout/use-sidebar-selection"
import type { ThreadState } from "@/hooks/use-thread-state"

/**
 * What a single conversation row needs. Named to match the row's own props so a
 * list can spread the bundle straight through — the names used to differ, so
 * every list rewrote the same three-line adapter by hand.
 */
export interface RowHandlers {
  selection: SidebarSelection
  onNavigate: () => void
  onRename: (thread: Thread) => void
  onDelete: (thread: Thread) => void
}

/**
 * {@link RowHandlers} plus the ambient state a list needs to derive each row's
 * {@link ThreadState}. Lives here rather than beside either panel, so the two
 * lists that render conversation rows — the workspace's own and Activity's
 * cross-workspace one — share a contract instead of one importing it from the
 * other.
 */
export interface ConversationHandlers extends RowHandlers {
  activeThreadId: string | null
  activeRuns: Set<string>
  /** Derives a row's active/running/unread state — see `use-thread-state`. */
  threadState: (thread: Thread) => ThreadState
}
