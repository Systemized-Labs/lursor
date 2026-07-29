import { FolderOpen } from "@phosphor-icons/react"

import type { Thread } from "@/api/types"
import { WorkspaceConversations } from "@/components/layout/panel/workspace-conversations"
import type { ConversationHandlers } from "@/components/layout/panel/types"

interface ChatsPanelProps extends ConversationHandlers {
  /** The scoped workspace's conversations, newest-first. */
  threads: Thread[]
  isLoading: boolean
  /** False once the workspace list has loaded and there are none at all. */
  hasWorkspace: boolean
  workspacesLoading: boolean
}

/**
 * One workspace's conversations, flat, filling the panel.
 *
 * This used to be a tree: every workspace as a collapsible folder, with a
 * cross-workspace Attention section above them, persisted expand state, and
 * per-folder unread badges. All of it existed because the panel was the only
 * place a workspace appeared, so it had to be a switcher and a conversation list
 * at once — and doing both jobs is why it did neither well. Getting back to a
 * workspace meant finding its folder, expanding it, then guessing which
 * conversation you had been in.
 *
 * The rail is the switcher now, and it carries the per-workspace status the
 * folder badges used to, so the tree has no job left. What's here is the list you
 * actually read, at full height and full width, with no row that opens into more
 * rows.
 */
export function ChatsPanel({
  threads,
  isLoading,
  hasWorkspace,
  workspacesLoading,
  ...handlers
}: ChatsPanelProps) {
  if (!hasWorkspace) {
    return (
      <div className="px-2 pb-2">
        {workspacesLoading ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</p>
        ) : (
          <p className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
            <FolderOpen className="size-4 shrink-0" />
            No workspaces yet.
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="px-2 pb-2">
      <WorkspaceConversations
        threads={threads}
        isLoading={isLoading}
        {...handlers}
      />
    </div>
  )
}
