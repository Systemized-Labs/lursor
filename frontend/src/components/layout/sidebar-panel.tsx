import { FolderPlus, MagnifyingGlass, Plus, Trash, X } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { useSidebar } from "@/components/ui/sidebar"
import { ActivityPanel } from "@/components/layout/panel/activity-panel"
import { ChatsPanel } from "@/components/layout/panel/chats-panel"
import { SkillsPanel } from "@/components/layout/panel/skills-panel"
import type { ConversationHandlers } from "@/components/layout/panel/types"
import type { OpenWorkspaces } from "@/components/layout/use-open-workspaces"
import type { PanelMode } from "@/components/layout/use-panel-mode"
import type { WorkspaceDialogs } from "@/components/layout/workspace-dialogs"
import type { AllThreads } from "@/hooks/use-all-threads"

/**
 * Everything that varies per mode, in one table. These four facts used to be
 * spread across a title record, two inline ternaries in the JSX and a render
 * chain whose final `else` silently caught anything unrecognised — so adding a
 * mode meant finding six places, one of which failed quietly.
 */
const PANELS: Record<
  PanelMode,
  { title: string; newConversation: boolean; workspaceFooter: boolean }
> = {
  chats: { title: "Conversations", newConversation: true, workspaceFooter: true },
  activity: { title: "Activity", newConversation: false, workspaceFooter: false },
  skills: { title: "Skill Studio", newConversation: true, workspaceFooter: false },
}

/** Header affordances share the panel's icon-button treatment. */
const HEADER_TILE = "size-7 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"

interface SidebarPanelProps {
  panelMode: PanelMode
  /** The one cross-workspace query every mode reads from. */
  threads: AllThreads
  openWorkspaces: OpenWorkspaces
  activeWorkspaceId: string | undefined
  handlers: ConversationHandlers
  dialogs: WorkspaceDialogs
  onNewConversation: (workspaceId: string) => void
  onNewChat: () => void
  onSearch: () => void
}

/**
 * The contextual column beside the rail: a header, the bulk-selection toolbar,
 * and whichever list the rail last put here.
 *
 * One scroll region for the whole thing. The old sidebar split the column
 * between a nav group capped at 55vh and a workspace group taking the rest — a
 * fixed carve-up of a scarce resource, where expanding two workspaces left the
 * conversations scrolling inside 45vh while mostly-static nav rows held the top
 * half. The nav rows are in the rail now, so there is nothing to split.
 */
export function SidebarPanel({
  panelMode,
  threads,
  openWorkspaces,
  activeWorkspaceId,
  handlers,
  dialogs,
  onNewConversation,
  onNewChat,
  onSearch,
}: SidebarPanelProps) {
  const { selection } = handlers
  const { isMobile, setOpenMobile } = useSidebar()
  const panel = PANELS[panelMode]

  // The header's ⊕ means "another conversation here" when you're inside a
  // workspace, and the New Agent home otherwise — there is no sensible
  // workspace to guess at from outside one.
  const handleNew = () => {
    const target =
      panelMode === "skills" ? threads.studioId : activeWorkspaceId
    if (target) onNewConversation(target)
    else onNewChat()
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-sidebar">
      <div className="flex h-12 shrink-0 items-center gap-1 px-2">
        <h2 className="min-w-0 flex-1 truncate px-1 text-sm font-semibold text-sidebar-foreground">
          {panel.title}
        </h2>
        <Button
          variant="ghost"
          size="icon"
          onClick={onSearch}
          aria-label="Search"
          title="Search (⌘K)"
          className={HEADER_TILE}
        >
          <MagnifyingGlass className="size-4" />
        </Button>
        {panel.newConversation ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={handleNew}
            aria-label="New conversation"
            title="New conversation"
            className={HEADER_TILE}
          >
            <Plus className="size-4" />
          </Button>
        ) : null}
        {/* The off-canvas sheet hides its own close, so give the drawer a clear
            dismiss affordance. */}
        {isMobile ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setOpenMobile(false)}
            aria-label="Close menu"
            className={HEADER_TILE}
          >
            <X className="size-4" />
          </Button>
        ) : null}
      </div>

      {/* Bulk-selection toolbar — appears once ⌘/⇧-click selects something.
          Plain clicks keep navigating throughout; "Done" or Esc clears. */}
      {selection.count > 0 ? (
        <div className="mx-2 mb-1 flex shrink-0 items-center gap-1 rounded-md border border-sidebar-border bg-sidebar-accent/50 px-2 py-1">
          <span className="flex-1 truncate text-xs font-medium text-sidebar-foreground">
            {selection.count}{" "}
            {selection.kind === "workspace"
              ? selection.count > 1
                ? "workspaces"
                : "workspace"
              : selection.count > 1
                ? "conversations"
                : "conversation"}
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
        {panelMode === "chats" ? (
          <ChatsPanel
            workspaces={threads.workspaces}
            allThreads={threads.threads}
            byWorkspace={threads.byWorkspace}
            workspaceName={threads.workspaceName}
            threadsLoading={threads.isLoading}
            workspacesLoading={threads.workspacesLoading}
            openWorkspaces={openWorkspaces}
            activeWorkspaceId={activeWorkspaceId}
            onNewConversation={onNewConversation}
            onRenameWorkspace={dialogs.openRenameWorkspace}
            onDeleteWorkspace={dialogs.openDeleteWorkspace}
            onCloneWorkspace={dialogs.openCloneWorkspace}
            {...handlers}
          />
        ) : panelMode === "activity" ? (
          <ActivityPanel
            allThreads={threads.threads}
            workspaceName={threads.workspaceName}
            isLoading={threads.isLoading}
            {...handlers}
          />
        ) : (
          <SkillsPanel
            threads={
              threads.studioId
                ? (threads.byWorkspace.get(threads.studioId) ?? [])
                : []
            }
            isLoading={threads.isLoading}
            {...handlers}
          />
        )}
      </div>

      {panel.workspaceFooter ? (
        <div className="shrink-0 border-t border-sidebar-border p-2">
          <button
            type="button"
            onClick={dialogs.openNewWorkspace}
            className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-sidebar-foreground/70 outline-none ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2"
          >
            <FolderPlus className="size-4 shrink-0" />
            <span className="truncate">New workspace</span>
          </button>
        </div>
      ) : null}
    </div>
  )
}
