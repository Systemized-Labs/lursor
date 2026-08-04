import { Trash } from "@phosphor-icons/react"

import type { Thread, Workspace } from "@/api/types"
import { Button } from "@/components/ui/button"
import { ActivityPanel } from "@/components/layout/panel/activity-panel"
import { ChatsPanel } from "@/components/layout/panel/chats-panel"
import { PanelHeader } from "@/components/layout/panel/panel-header"
import type { ConversationHandlers } from "@/components/layout/panel/types"
import type { PanelMode } from "@/components/layout/use-panel-mode"
import type { WorkspaceDialogs } from "@/components/layout/workspace-dialogs"
import type { AllThreads } from "@/hooks/use-all-threads"

interface SidebarPanelProps {
  panelMode: PanelMode
  /** The one cross-workspace query every mode reads from. */
  threads: AllThreads
  /**
   * The workspace the Chats list is showing. Usually the one you're in; the most
   * recent one when you're on a page that isn't a workspace at all.
   */
  scopedWorkspace: Workspace | undefined
  scopedThreads: Thread[]
  handlers: ConversationHandlers
  dialogs: WorkspaceDialogs
  onNewConversation: (workspaceId: string) => void
  onNewChat: () => void
  onSearch: () => void
}

/**
 * The contextual column beside the rail: a header naming what you're looking at,
 * the bulk-selection toolbar, and the list.
 *
 * Two modes now, where there were three. "Skills" was the Skill Studio's
 * conversations, which needed a mode of its own only because the studio is a
 * workspace that had no way to be one — it is a rail tile now, and its
 * conversations are just the Chats list scoped to it, so the mode, its panel and
 * its per-mode config row all went away.
 *
 * The header carries the workspace name because the panel is scoped to one and
 * the rail's 10px label truncates. Between them you can always answer "which
 * repo am I in" — a question the old sidebar left unanswered anywhere on screen
 * once the panel was collapsed.
 */
export function SidebarPanel({
  panelMode,
  threads,
  scopedWorkspace,
  scopedThreads,
  handlers,
  dialogs,
  onNewConversation,
  onNewChat,
  onSearch,
}: SidebarPanelProps) {
  const { selection } = handlers

  const isChats = panelMode === "chats"

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-sidebar">
      {/* The header lives here on every platform now. It used to be hoisted into
          the sidebar's macOS chrome strip so the heading shared the traffic
          lights' line; with the WindowBar owning that band there is no strip to
          hoist it into, and one code path replaces two. */}
      <div className="flex h-10 shrink-0 items-center">
        <PanelHeader
          panelMode={panelMode}
          scopedWorkspace={scopedWorkspace}
          onNewConversation={onNewConversation}
          onNewChat={onNewChat}
          onSearch={onSearch}
        />
      </div>

      {/* Bulk-selection toolbar — appears once ⌘/⇧-click selects something.
          Plain clicks keep navigating throughout; "Done" or Esc clears. */}
      {selection.count > 0 ? (
        <div className="mx-2 mb-1 flex shrink-0 items-center gap-1 rounded-md border border-sidebar-border bg-sidebar-accent/50 px-2 py-1">
          <span className="flex-1 truncate text-xs font-medium text-sidebar-foreground">
            {selection.count}{" "}
            {selection.count > 1 ? "conversations" : "conversation"}
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={dialogs.openBulkDelete}
            title="Delete selected"
            aria-label="Delete selected"
            className="size-6 text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash className="size-4" />
          </Button>
          <button
            type="button"
            onClick={selection.clear}
            aria-label="Done selecting"
            className="rounded-md px-2 py-0.5 text-xs font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            Done
          </button>
        </div>
      ) : null}

      <div className="scrollbar-hover min-h-0 flex-1 overflow-y-auto">
        {isChats ? (
          <ChatsPanel
            threads={scopedThreads}
            isLoading={threads.isLoading}
            hasWorkspace={Boolean(scopedWorkspace)}
            workspacesLoading={threads.workspacesLoading}
            {...handlers}
          />
        ) : (
          <ActivityPanel
            allThreads={threads.threads}
            workspaceName={threads.workspaceName}
            isLoading={threads.isLoading}
            {...handlers}
          />
        )}
      </div>
    </div>
  )
}
