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
 * A workspace's conversations, as the panel's whole list.
 *
 * The rows come from the cross-workspace list the sidebar already holds rather
 * than a per-workspace fetch. `GET /threads?workspace_id=` returns the same rows
 * in the same order, so a second query bought nothing and cost an extra request —
 * refired on every run-finish, stream-end and rename, because the invalidation
 * sweep has to hit both cache shapes.
 */
export function WorkspaceConversations({
  threads,
  isLoading,
  emptyLabel = "No conversations",
  threadState,
  selection,
  isPinned,
  onTogglePin,
  ...rowHandlers
}: WorkspaceConversationsProps) {
  if (isLoading) {
    return <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</p>
  }
  if (threads.length === 0) {
    return (
      <p className="px-2 py-1.5 text-xs text-muted-foreground">{emptyLabel}</p>
    )
  }

  return (
    // Flush, not indented: these rows used to hang off a folder header, and the
    // rail is the folder now.
    <ul className="flex min-w-0 flex-col">
      {threads.map((thread) => (
        <ConversationRow
          key={thread.id}
          {...rowHandlers}
          thread={thread}
          state={threadState(thread)}
          isSelected={selection.isThreadSelected(thread.id)}
          isPinned={isPinned(thread.id)}
          onTogglePin={() => onTogglePin(thread.id)}
          selection={selection}
          onSelect={(mods) => selection.selectThread(thread, mods, threads)}
        />
      ))}
    </ul>
  )
}
