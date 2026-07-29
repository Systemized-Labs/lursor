import type { Thread } from "@/api/types"
import { ConversationRow } from "@/components/layout/panel/conversation-row"
import type { ConversationHandlers } from "@/components/layout/panel/types"

interface WorkspaceConversationsProps extends ConversationHandlers {
  /** Already newest-first — a slice of the cross-workspace list. */
  threads: Thread[]
  isLoading: boolean
  emptyLabel?: string
}

/**
 * A workspace's conversations, nested under its section header.
 *
 * The rows come from the cross-workspace list the sidebar already holds rather
 * than a per-workspace fetch. `GET /threads?workspace_id=` returns the same rows
 * in the same order, so a second query bought nothing and cost a request per
 * expanded folder — refired on every run-finish, stream-end and rename, because
 * the invalidation sweep has to hit both cache shapes.
 */
export function WorkspaceConversations({
  threads,
  isLoading,
  emptyLabel = "No conversations",
  threadState,
  selection,
  ...rowHandlers
}: WorkspaceConversationsProps) {
  if (isLoading) {
    return (
      <p className="py-1 pl-8 text-[11px] text-muted-foreground">Loading…</p>
    )
  }
  if (threads.length === 0) {
    return (
      <p className="py-1 pl-8 text-[11px] text-muted-foreground">{emptyLabel}</p>
    )
  }

  return (
    <ul className="ml-3 flex min-w-0 flex-col border-l border-sidebar-border pl-1.5">
      {threads.map((thread) => (
        <ConversationRow
          key={thread.id}
          thread={thread}
          state={threadState(thread)}
          isSelected={selection.isThreadSelected(thread.id)}
          selection={selection}
          onSelect={(mods) => selection.selectThread(thread, mods, threads)}
          {...rowHandlers}
        />
      ))}
    </ul>
  )
}
