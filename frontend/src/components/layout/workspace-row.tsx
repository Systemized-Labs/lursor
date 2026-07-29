import {
  ChatCentered,
  Clock,
  Folder,
  FolderOpen,
  GitBranch,
  Pencil,
  Plus,
  Sparkle,
  Trash,
} from "@phosphor-icons/react"
import { type DragEvent, type MouseEvent, useEffect, useMemo } from "react"
import { Link } from "react-router-dom"

import type { Thread, WorkspaceFolder } from "@/api/types"
import { useThreads } from "@/api/threads"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { DotGridLoader } from "@/components/ui/dot-grid-loader"
import {
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar"
import {
  markThreadRead,
  seedThreadRead,
  useThreadReads,
} from "@/hooks/use-thread-reads"
import type {
  SelectMods,
  SidebarSelection,
} from "@/components/layout/use-sidebar-selection"
import { cn } from "@/lib/utils"

/** Compact relative time ("3s" / "5m" / "2h" / "4d"). */
function timeAgo(iso?: string): string {
  if (!iso) return ""
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ""
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/**
 * Drag wiring handed down by the tree that owns the arrangement (see
 * `workspace-tree.tsx`). Absent on rows that don't move — the studio.
 */
export interface RowDrag {
  onDragStart: (event: DragEvent<HTMLElement>) => void
  onDragEnd: () => void
  onDragOver: (event: DragEvent<HTMLElement>) => void
  onDrop: (event: DragEvent<HTMLElement>) => void
  /** Show the insertion line: the drop would land immediately above this row. */
  dropBefore: boolean
  /** This is the row under the cursor's grip. */
  dragging: boolean
}

/**
 * Refiling by name instead of by drag. The menu picks a group, not a slot — and
 * it's the only route on a touch screen, where HTML5 drag doesn't fire at all.
 */
export interface MoveToFolder {
  folders: WorkspaceFolder[]
  currentFolderId: string | null
  onMove: (folderId: string | null) => void
}

/** The insertion line a drag leaves between two rows. */
export function DropLine() {
  return (
    <div className="pointer-events-none absolute -top-0.5 left-1 right-1 z-10 h-0.5 rounded-full bg-primary" />
  )
}

interface WorkspaceRowProps {
  /** Undefined only for the studio row before the workspace list has loaded: the
   *  row still renders, it just has nowhere to travel to yet. */
  workspaceId: string | undefined
  name: string
  /**
   * App-owned (the skills catalog): distinct glyph, and none of the workspace
   * management — no rename (the nav label is fixed), no delete, no clone.
   */
  isSystem: boolean
  isOpen: boolean
  isActive: boolean
  isSelected: boolean
  selection: SidebarSelection
  onSelect: (mods: SelectMods) => void
  activeThreadId: string | null
  activeRuns: Set<string>
  onToggle: () => void
  onNewConversation: () => void
  onNavigate: () => void
  onRename: (thread: Thread) => void
  onDelete: (thread: Thread) => void
  onRenameWorkspace: () => void
  onDeleteWorkspace: () => void
  onCloneWorkspace: () => void
  drag?: RowDrag
  moveTo?: MoveToFolder
}

export function WorkspaceRow({
  workspaceId,
  name,
  isSystem,
  isOpen,
  isActive,
  isSelected,
  selection,
  onSelect,
  activeThreadId,
  activeRuns,
  onToggle,
  onNewConversation,
  onNavigate,
  onRename,
  onDelete,
  onRenameWorkspace,
  onDeleteWorkspace,
  onCloneWorkspace,
  drag,
  moveTo,
}: WorkspaceRowProps) {
  const handleClick = (e: MouseEvent) => {
    // ⌘/ctrl toggles this workspace; ⇧ extends a range. Once a workspace
    // selection is active ("sticky" mode) a plain click also toggles, so the
    // selection is never lost by an errant click and folders don't navigate
    // away mid-select. Esc / Done exits. A plain click while nothing (or only
    // conversations) is selected keeps the normal folder open/close behaviour.
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault()
      onSelect({ toggle: true, range: false })
    } else if (e.shiftKey) {
      e.preventDefault()
      onSelect({ toggle: false, range: true })
    } else if (selection.count > 0) {
      e.preventDefault()
      onSelect({ toggle: true, range: false })
    } else {
      onToggle()
    }
  }

  const button = (
    <SidebarMenuButton
      isActive={isActive}
      tooltip={name}
      onClick={handleClick}
      className={cn(
        "select-none",
        isSelected &&
          "bg-primary/15 text-foreground hover:bg-primary/20 data-[active=true]:bg-primary/25"
      )}
    >
      {/* The skills catalog keeps one glyph open or closed — it reads as
          a destination rather than a folder you filed things into. */}
      {isSystem ? (
        <Sparkle className="size-4" />
      ) : isOpen ? (
        <FolderOpen className="size-4" />
      ) : (
        <Folder className="size-4" />
      )}
      <span className="flex-1 truncate">{name}</span>
    </SidebarMenuButton>
  )

  return (
    <SidebarMenuItem className="group/workspace relative">
      {/* The grip is the row itself, not the conversations hanging off it —
          dragging a workspace shouldn't take a chat list along for the ride. */}
      <div
        className={cn("relative", drag?.dragging && "opacity-40")}
        draggable={Boolean(drag)}
        onDragStart={drag?.onDragStart}
        onDragEnd={drag?.onDragEnd}
        onDragOver={drag?.onDragOver}
        onDrop={drag?.onDrop}
      >
        {drag?.dropBefore ? <DropLine /> : null}
        {/* Nothing to manage on the catalog row: its label is a fixed nav label,
            delete is refused by the API, and cloning a repo into the catalog would
            strew a checkout through your skills. No menu at all, then. */}
        {isSystem ? (
          button
        ) : (
          <ContextMenu>
            <ContextMenuTrigger asChild>{button}</ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={onRenameWorkspace}>
                <Pencil className="size-4" />
                Rename
              </ContextMenuItem>
              <ContextMenuItem onSelect={onCloneWorkspace}>
                <GitBranch className="size-4" />
                Clone repo
              </ContextMenuItem>
              {moveTo && moveTo.folders.length > 0 ? (
                <ContextMenuSub>
                  <ContextMenuSubTrigger>
                    <Folder className="size-4" />
                    Move to
                  </ContextMenuSubTrigger>
                  <ContextMenuSubContent>
                    <ContextMenuItem
                      disabled={moveTo.currentFolderId === null}
                      onSelect={() => moveTo.onMove(null)}
                    >
                      Top level
                    </ContextMenuItem>
                    <ContextMenuSeparator />
                    {moveTo.folders.map((folder) => (
                      <ContextMenuItem
                        key={folder.id}
                        disabled={folder.id === moveTo.currentFolderId}
                        onSelect={() => moveTo.onMove(folder.id)}
                      >
                        {folder.name}
                      </ContextMenuItem>
                    ))}
                  </ContextMenuSubContent>
                </ContextMenuSub>
              ) : null}
              <ContextMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={onDeleteWorkspace}
              >
                <Trash className="size-4" />
                Delete
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )}
      </div>

      <button
        type="button"
        aria-label="New conversation"
        title="New conversation"
        onClick={(e) => {
          e.stopPropagation()
          onNewConversation()
        }}
        className="absolute right-1 top-1.5 flex size-5 items-center justify-center rounded-md text-sidebar-foreground opacity-0 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:opacity-100 group-hover/workspace:opacity-100 group-data-[collapsible=icon]:hidden"
      >
        <Plus className="size-4" />
      </button>

      <WorkspaceThreads
        workspaceId={workspaceId}
        isOpen={isOpen}
        activeThreadId={activeThreadId}
        activeRuns={activeRuns}
        selection={selection}
        onNavigate={onNavigate}
        onRename={onRename}
        onDelete={onDelete}
      />
    </SidebarMenuItem>
  )
}

interface WorkspaceThreadsProps {
  /** Undefined until the owning workspace is known; the query stays idle. */
  workspaceId: string | undefined
  isOpen: boolean
  activeThreadId: string | null
  activeRuns: Set<string>
  selection: SidebarSelection
  onNavigate: () => void
  onRename: (thread: Thread) => void
  onDelete: (thread: Thread) => void
}

/**
 * Nested conversation list. Always mounts (and fetches) so read state stays
 * current, but when the folder is collapsed it shows only the conversations
 * that still warrant attention — the active chat, anything running, and any
 * pending unread replies — hiding the rest.
 */
function WorkspaceThreads({
  workspaceId,
  isOpen,
  activeThreadId,
  activeRuns,
  selection,
  onNavigate,
  onRename,
  onDelete,
}: WorkspaceThreadsProps) {
  const threadsQuery = useThreads(workspaceId)
  const threads = useMemo(() => threadsQuery.data ?? [], [threadsQuery.data])
  const { isUnread } = useThreadReads()

  // Reconcile read state: record threads on first sight (so pre-existing
  // activity isn't retroactively flagged) and keep the open conversation marked
  // read as its activity advances.
  useEffect(() => {
    for (const thread of threads) {
      seedThreadRead(thread.id, thread.updated_at)
      if (thread.id === activeThreadId) {
        markThreadRead(thread.id, thread.updated_at)
      }
    }
  }, [threads, activeThreadId])

  // While collapsed, keep only chats that still need attention: the active
  // conversation, anything currently running, and pending unread replies.
  const visibleThreads = useMemo(() => {
    if (isOpen) return threads
    return threads.filter(
      (thread) =>
        thread.id === activeThreadId ||
        activeRuns.has(thread.id) ||
        isUnread(thread.id, thread.updated_at)
    )
  }, [isOpen, threads, activeThreadId, activeRuns, isUnread])

  // Collapsed with nothing worth surfacing: render nothing at all.
  if (!isOpen && visibleThreads.length === 0) return null

  return (
    <SidebarMenuSub className="mx-2 px-1.5">
      {isOpen && threadsQuery.isLoading ? (
        <li className="px-2 py-1 text-[11px] text-muted-foreground">Loading…</li>
      ) : isOpen && threads.length === 0 ? (
        <li className="px-2 py-1 text-[11px] text-muted-foreground">
          No conversations
        </li>
      ) : (
        visibleThreads.map((thread) => (
          <SessionRow
            key={thread.id}
            thread={thread}
            isActive={thread.id === activeThreadId}
            running={activeRuns.has(thread.id)}
            unread={
              thread.id !== activeThreadId &&
              !activeRuns.has(thread.id) &&
              isUnread(thread.id, thread.updated_at)
            }
            isSelected={selection.isThreadSelected(thread.id)}
            selection={selection}
            onSelect={(mods) =>
              selection.selectThread(thread, mods, visibleThreads)
            }
            onNavigate={onNavigate}
            onRename={onRename}
            onDelete={onDelete}
          />
        ))
      )}
    </SidebarMenuSub>
  )
}

interface SessionRowProps {
  thread: Thread
  isActive: boolean
  running: boolean
  /** A reply landed since this conversation was last opened. */
  unread: boolean
  isSelected: boolean
  selection: SidebarSelection
  onSelect: (mods: SelectMods) => void
  onNavigate: () => void
  onRename: (thread: Thread) => void
  onDelete: (thread: Thread) => void
}

function SessionRow({
  thread,
  isActive,
  running,
  unread,
  isSelected,
  selection,
  onSelect,
  onNavigate,
  onRename,
  onDelete,
}: SessionRowProps) {
  const handleClick = (e: MouseEvent) => {
    // ⌘/ctrl toggles this conversation; ⇧ extends a range within this
    // workspace. Once any selection is active ("sticky" mode) a plain click
    // toggles too instead of navigating, so clicks never lose the selection or
    // yank you to another chat. Esc / Done exits back to normal navigation.
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault()
      onSelect({ toggle: true, range: false })
    } else if (e.shiftKey) {
      e.preventDefault()
      onSelect({ toggle: false, range: true })
    } else if (selection.count > 0) {
      e.preventDefault()
      onSelect({ toggle: true, range: false })
    } else {
      onNavigate()
    }
  }

  return (
    <SidebarMenuSubItem className="group/session">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <SidebarMenuSubButton
            asChild
            isActive={isActive}
            className={cn(
              "select-none",
              isSelected &&
                "bg-primary/15 text-foreground hover:bg-primary/20 data-[active=true]:bg-primary/25"
            )}
          >
            <Link
              to={`/workspaces/${thread.workspace_id}/chat?c=${thread.id}`}
              onClick={handleClick}
              // A link is draggable by default, which would start a URL drag
              // from inside a row whose grip means "refile this workspace".
              draggable={false}
            >
              {running ? (
                <DotGridLoader
                  size="xs"
                  className="shrink-0 text-primary"
                  label="Working"
                />
              ) : unread ? (
                <ChatCentered
                  weight="fill"
                  className="size-4 shrink-0 text-success"
                />
              ) : (
                <ChatCentered className="size-4" />
              )}
              <span
                className={cn(
                  "flex-1 truncate",
                  running && "text-primary",
                  unread && "font-medium text-foreground"
                )}
              >
                {thread.title || "Untitled"}
              </span>
              {/* Nobody started this one — a schedule did. Sits beside the
                  timestamp rather than replacing the leading icon, which is the
                  running/unread slot and carries the more urgent signal. */}
              {thread.schedule_id ? (
                <Clock
                  className="size-3 shrink-0 text-muted-foreground/70"
                  aria-label="Started by a schedule"
                />
              ) : null}
              <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
                {timeAgo(thread.updated_at)}
              </span>
            </Link>
          </SidebarMenuSubButton>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => onRename(thread)}>
            <Pencil className="size-4" />
            Rename
          </ContextMenuItem>
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={() => onDelete(thread)}
          >
            <Trash className="size-4" />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </SidebarMenuSubItem>
  )
}
