import {
  CaretDown,
  CaretRight,
  Folder,
  FolderOpen,
  GitBranch,
  Pencil,
  Plus,
  Trash,
} from "@phosphor-icons/react"
import type { MouseEvent } from "react"

import type { Thread, Workspace } from "@/api/types"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { WorkspaceConversations } from "@/components/layout/panel/workspace-conversations"
import type { ConversationHandlers } from "@/components/layout/panel/types"
import type { SelectMods } from "@/components/layout/use-sidebar-selection"
import { cn } from "@/lib/utils"

interface WorkspaceSectionProps extends ConversationHandlers {
  workspace: Workspace
  /** This workspace's conversations, newest-first. */
  threads: Thread[]
  isLoading: boolean
  isOpen: boolean
  isActive: boolean
  isSelected: boolean
  /** Unread conversations in this workspace; badged while collapsed. */
  unreadCount: number
  onToggle: () => void
  onSelect: (mods: SelectMods) => void
  onNewConversation: (workspaceId: string) => void
  onRenameWorkspace: (workspace: Workspace) => void
  onDeleteWorkspace: (workspace: Workspace) => void
  onCloneWorkspace: (workspace: Workspace) => void
}

/**
 * One workspace as a collapsible section of the Chats panel.
 *
 * Collapsed means collapsed: the section renders *nothing* below its header.
 * The old sidebar leaked running and unread conversations out of a shut folder,
 * so its height changed on its own as runs started and finished and rows below
 * shifted under the cursor. Attention (a fixed section at the top of the panel)
 * is where that now lives, and the count moves to a badge here — a number that
 * changes in place instead of a row that appears.
 */
export function WorkspaceSection({
  workspace,
  threads,
  isLoading,
  isOpen,
  isActive,
  isSelected,
  unreadCount,
  onToggle,
  onSelect,
  onNewConversation,
  onRenameWorkspace,
  onDeleteWorkspace,
  onCloneWorkspace,
  ...handlers
}: WorkspaceSectionProps) {
  const handleClick = (e: MouseEvent) => {
    // ⌘/ctrl toggles this workspace in the bulk selection; ⇧ extends a range.
    // A plain click is always the folder toggle.
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault()
      onSelect({ toggle: true, range: false })
    } else if (e.shiftKey) {
      e.preventDefault()
      onSelect({ toggle: false, range: true })
    } else {
      onToggle()
    }
  }

  const header = (
    <button
      type="button"
      onClick={handleClick}
      aria-expanded={isOpen}
      className={cn(
        "flex h-8 w-full min-w-0 select-none items-center gap-1.5 rounded-md pl-1 pr-7 text-sm text-sidebar-foreground outline-none ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2",
        isActive && "font-medium text-sidebar-accent-foreground",
        isSelected && "bg-primary/15 text-foreground hover:bg-primary/20"
      )}
    >
      {isOpen ? (
        <CaretDown className="size-3 shrink-0 text-sidebar-foreground/60" />
      ) : (
        <CaretRight className="size-3 shrink-0 text-sidebar-foreground/60" />
      )}
      {isOpen ? (
        <FolderOpen className="size-4 shrink-0" />
      ) : (
        <Folder className="size-4 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate text-left">
        {workspace.name}
      </span>
      {!isOpen && unreadCount > 0 ? (
        <span className="shrink-0 rounded-full bg-sidebar-accent px-1.5 text-[10px] font-medium tabular-nums text-sidebar-accent-foreground">
          {unreadCount}
        </span>
      ) : null}
    </button>
  )

  return (
    <li className="group/workspace relative">
      <ContextMenu>
        <ContextMenuTrigger asChild>{header}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => onRenameWorkspace(workspace)}>
            <Pencil className="size-4" />
            Rename
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onCloneWorkspace(workspace)}>
            <GitBranch className="size-4" />
            Clone repo
          </ContextMenuItem>
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={() => onDeleteWorkspace(workspace)}
          >
            <Trash className="size-4" />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <button
        type="button"
        aria-label={`New conversation in ${workspace.name}`}
        title="New conversation"
        onClick={(e) => {
          e.stopPropagation()
          onNewConversation(workspace.id)
        }}
        className="absolute right-1 top-1.5 flex size-5 items-center justify-center rounded-md text-sidebar-foreground/70 opacity-0 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:opacity-100 group-hover/workspace:opacity-100"
      >
        <Plus className="size-4" />
      </button>

      {isOpen ? (
        <WorkspaceConversations
          threads={threads}
          isLoading={isLoading}
          {...handlers}
        />
      ) : null}
    </li>
  )
}
