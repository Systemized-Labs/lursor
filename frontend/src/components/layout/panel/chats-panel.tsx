import { CaretDown, CaretRight } from "@phosphor-icons/react"
import { useMemo, useState } from "react"

import type { Thread, Workspace } from "@/api/types"
import { ConversationRow } from "@/components/layout/panel/conversation-row"
import { WorkspaceSection } from "@/components/layout/panel/workspace-section"
import type { ConversationHandlers } from "@/components/layout/panel/types"
import type { OpenWorkspaces } from "@/components/layout/use-open-workspaces"

interface ChatsPanelProps extends ConversationHandlers {
  /** Your workspaces — the studio is a rail destination, not a folder here. */
  workspaces: Workspace[]
  /** Every conversation everywhere; feeds Attention and the collapsed badges. */
  allThreads: Thread[]
  byWorkspace: Map<string, Thread[]>
  workspaceName: (workspaceId: string) => string
  threadsLoading: boolean
  workspacesLoading: boolean
  openWorkspaces: OpenWorkspaces
  activeWorkspaceId: string | undefined
  onNewConversation: (workspaceId: string) => void
  onRenameWorkspace: (workspace: Workspace) => void
  onDeleteWorkspace: (workspace: Workspace) => void
  onCloneWorkspace: (workspace: Workspace) => void
}

/**
 * The Chats panel: a cross-workspace Attention section over one collapsible
 * section per workspace. One scroll region for the lot — the destinations that
 * used to hold the top 55% of the column now live in the rail, so conversations
 * get the full height.
 */
export function ChatsPanel({
  workspaces,
  allThreads,
  byWorkspace,
  workspaceName,
  threadsLoading,
  workspacesLoading,
  openWorkspaces,
  activeWorkspaceId,
  onNewConversation,
  onRenameWorkspace,
  onDeleteWorkspace,
  onCloneWorkspace,
  ...handlers
}: ChatsPanelProps) {
  const { threadState, selection } = handlers
  const [attentionOpen, setAttentionOpen] = useState(true)

  // One pass for both derivations: anything wanting you now, and how many of
  // those each collapsed section is hiding.
  const { attention, unreadByWorkspace } = useMemo(() => {
    const rows: Thread[] = []
    const counts = new Map<string, number>()
    for (const thread of allThreads) {
      const { needsAttention, unread } = threadState(thread)
      if (needsAttention) rows.push(thread)
      if (unread) {
        counts.set(
          thread.workspace_id,
          (counts.get(thread.workspace_id) ?? 0) + 1
        )
      }
    }
    return { attention: rows, unreadByWorkspace: counts }
  }, [allThreads, threadState])

  const orderedWorkspaceIds = useMemo(
    () => workspaces.map((ws) => ws.id),
    [workspaces]
  )

  return (
    <div className="flex flex-col gap-2 px-2 pb-2">
      {/* No permanent dead header: the section only exists when something in it
          actually wants you. */}
      {attention.length > 0 ? (
        <section>
          <button
            type="button"
            onClick={() => setAttentionOpen((prev) => !prev)}
            aria-expanded={attentionOpen}
            className="flex h-7 w-full items-center gap-1 rounded-md px-1 text-xs font-medium uppercase tracking-wide text-sidebar-foreground/70 hover:text-sidebar-foreground"
          >
            {attentionOpen ? (
              <CaretDown className="size-3 shrink-0" />
            ) : (
              <CaretRight className="size-3 shrink-0" />
            )}
            <span className="flex-1 text-left">Attention</span>
            <span className="tabular-nums">{attention.length}</span>
          </button>
          {attentionOpen ? (
            <ul className="flex min-w-0 flex-col">
              {attention.map((thread) => (
                <ConversationRow
                  key={`attention:${thread.id}`}
                  thread={thread}
                  state={threadState(thread)}
                  workspaceName={workspaceName(thread.workspace_id)}
                  isSelected={selection.isThreadSelected(thread.id)}
                  onSelect={(mods) =>
                    selection.selectThread(thread, mods, attention)
                  }
                  {...handlers}
                />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <ul className="flex min-w-0 flex-col">
        {workspacesLoading ? (
          <li className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</li>
        ) : workspaces.length === 0 ? (
          <li className="px-2 py-1.5 text-xs text-muted-foreground">
            No workspaces yet.
          </li>
        ) : (
          workspaces.map((ws) => (
            <WorkspaceSection
              key={ws.id}
              workspace={ws}
              threads={byWorkspace.get(ws.id) ?? []}
              isLoading={threadsLoading}
              isOpen={openWorkspaces.isOpen(ws.id)}
              isActive={activeWorkspaceId === ws.id}
              isSelected={selection.isWorkspaceSelected(ws.id)}
              unreadCount={unreadByWorkspace.get(ws.id) ?? 0}
              onToggle={() => openWorkspaces.toggle(ws.id)}
              onSelect={(mods) =>
                selection.selectWorkspace(ws.id, mods, orderedWorkspaceIds)
              }
              onNewConversation={onNewConversation}
              onRenameWorkspace={onRenameWorkspace}
              onDeleteWorkspace={onDeleteWorkspace}
              onCloneWorkspace={onCloneWorkspace}
              {...handlers}
            />
          ))
        )}
      </ul>
    </div>
  )
}
