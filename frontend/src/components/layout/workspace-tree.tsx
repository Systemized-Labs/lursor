import { CaretDown, CaretRight, Pencil, Trash } from "@phosphor-icons/react"
import {
  type DragEvent,
  type ReactNode,
  useCallback,
  useMemo,
  useState,
} from "react"
import { toast } from "sonner"

import { useSaveSidebarLayout } from "@/api/workspace-folders"
import type {
  SidebarLayout,
  Thread,
  Workspace,
  WorkspaceFolder,
} from "@/api/types"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar"
import { useWorkspaceUnread } from "@/hooks/use-workspace-unread"
import type { SidebarSelection } from "@/components/layout/use-sidebar-selection"
import {
  DropLine,
  type RowDrag,
  WorkspaceRow,
} from "@/components/layout/workspace-row"
import { cn } from "@/lib/utils"

/**
 * Which folders the user has shut, remembered per device. Collapse is a view
 * preference rather than shared state — and storing the *shut* ones means a
 * folder made on another device (or by an import) arrives open, showing what's
 * in it instead of hiding it behind a caret nobody knew to click.
 */
const COLLAPSED_KEY = "lursor:workspace-folders-collapsed"

function loadCollapsed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((id): id is string => typeof id === "string"))
  } catch {
    return new Set()
  }
}

function saveCollapsed(ids: Set<string>) {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]))
  } catch {
    // Ignore quota / disabled-storage errors — this is a view preference.
  }
}

/**
 * A row's identity in the root list, where folders and ungrouped workspaces
 * share one ordering. Prefixed because the two id spaces are separate.
 */
type RowKey = string

const folderKey = (id: string): RowKey => `f:${id}`
const workspaceKey = (id: string): RowKey => `w:${id}`

type TreeRow =
  | { kind: "folder"; key: RowKey; folder: WorkspaceFolder; children: Workspace[] }
  | { kind: "workspace"; key: RowKey; workspace: Workspace }

/** What's being dragged. */
interface DragRef {
  kind: "folder" | "workspace"
  id: string
}

/**
 * Where a drop would land, expressed as "insert before this row" rather than as
 * an index — the list is renumbered by the drop itself, and an anchor survives
 * that where a number wouldn't. `null` means the end of its list, which for a
 * folder is the same gesture as dropping onto the folder's own row.
 */
type DropTarget =
  | { kind: "root"; beforeKey: RowKey | null }
  | { kind: "folder"; folderId: string; beforeId: string | null }

/** Which third of a row the cursor is over. */
function edge(
  event: DragEvent<HTMLElement>,
  allowInto: boolean
): "before" | "after" | "into" {
  const rect = event.currentTarget.getBoundingClientRect()
  const offset = (event.clientY - rect.top) / (rect.height || 1)
  if (allowInto) {
    if (offset < 0.3) return "before"
    if (offset > 0.7) return "after"
    return "into"
  }
  return offset < 0.5 ? "before" : "after"
}

interface WorkspaceTreeProps {
  /** Your workspaces (the studio lives in Platform and isn't part of the tree). */
  workspaces: Workspace[]
  folders: WorkspaceFolder[]
  isLoading: boolean
  activeWorkspaceId: string | undefined
  activeThreadId: string | null
  activeRuns: Set<string>
  openWorkspaces: Set<string>
  onToggleWorkspace: (id: string) => void
  onNewConversation: (id: string) => void
  selection: SidebarSelection
  onNavigate: () => void
  onRenameThread: (thread: Thread) => void
  onDeleteThread: (thread: Thread) => void
  onRenameWorkspace: (workspace: Workspace) => void
  onDeleteWorkspace: (workspace: Workspace) => void
  onCloneWorkspace: (workspace: Workspace) => void
  onRenameFolder: (folder: WorkspaceFolder) => void
  onDeleteFolder: (folder: WorkspaceFolder) => void
}

/**
 * The workspace list, grouped. Folders are one level deep and hold nothing but
 * workspaces, so the whole arrangement is a root sequence (groups and loose
 * workspaces interleaved) plus one ordered list per group — which is what the
 * layout endpoint takes after every drop.
 */
export function WorkspaceTree({
  workspaces,
  folders,
  isLoading,
  activeWorkspaceId,
  activeThreadId,
  activeRuns,
  openWorkspaces,
  onToggleWorkspace,
  onNewConversation,
  selection,
  onNavigate,
  onRenameThread,
  onDeleteThread,
  onRenameWorkspace,
  onDeleteWorkspace,
  onCloneWorkspace,
  onRenameFolder,
  onDeleteFolder,
}: WorkspaceTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed)
  const [drag, setDrag] = useState<DragRef | null>(null)
  const [target, setTarget] = useState<DropTarget | null>(null)
  const saveLayout = useSaveSidebarLayout()

  const rows = useMemo(() => buildRows(workspaces, folders), [workspaces, folders])

  // Range selection walks what's on screen, so a workspace inside a shut folder
  // isn't in the run between two visible rows.
  const orderedWorkspaceIds = useMemo(() => {
    const ids: string[] = []
    for (const row of rows) {
      if (row.kind === "workspace") ids.push(row.workspace.id)
      else if (!collapsed.has(row.folder.id)) {
        for (const child of row.children) ids.push(child.id)
      }
    }
    return ids
  }, [rows, collapsed])

  const workspaceIds = useMemo(
    () => workspaces.map((ws) => ws.id),
    [workspaces]
  )
  const unreadByWorkspace = useWorkspaceUnread(workspaceIds, {
    activeThreadId,
    runningThreadIds: activeRuns,
  })

  const toggleFolder = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      saveCollapsed(next)
      return next
    })
  }

  const expandFolder = (id: string) => {
    setCollapsed((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      saveCollapsed(next)
      return next
    })
  }

  const endDrag = useCallback(() => {
    setDrag(null)
    setTarget(null)
  }, [])

  const startDrag = (ref: DragRef) => (event: DragEvent<HTMLElement>) => {
    setDrag(ref)
    event.dataTransfer.effectAllowed = "move"
    // Firefox won't start a drag without payload; the id is only a fallback,
    // the arrangement is computed from `drag` state.
    event.dataTransfer.setData("text/plain", ref.id)
  }

  /** Lift one row out of the arrangement, drop it back in, and save the result. */
  const move = (moved: DragRef, destination: DropTarget) => {
    // Groups don't nest, so a group can only ever land in the root sequence.
    if (moved.kind === "folder" && destination.kind === "folder") return

    const rootKeys = rows.map((row) => row.key)
    const children = new Map<string, string[]>()
    for (const row of rows) {
      if (row.kind === "folder") {
        children.set(
          row.folder.id,
          row.children.map((child) => child.id)
        )
      }
    }

    const movedKey =
      moved.kind === "folder" ? folderKey(moved.id) : workspaceKey(moved.id)

    const fromRoot = rootKeys.indexOf(movedKey)
    if (fromRoot !== -1) {
      rootKeys.splice(fromRoot, 1)
    } else {
      for (const ids of children.values()) {
        const index = ids.indexOf(moved.id)
        if (index !== -1) {
          ids.splice(index, 1)
          break
        }
      }
    }

    if (destination.kind === "root") {
      const before =
        destination.beforeKey === null
          ? -1
          : rootKeys.indexOf(destination.beforeKey)
      rootKeys.splice(before === -1 ? rootKeys.length : before, 0, movedKey)
    } else {
      const ids = children.get(destination.folderId)
      if (!ids) return
      const before =
        destination.beforeId === null ? -1 : ids.indexOf(destination.beforeId)
      ids.splice(before === -1 ? ids.length : before, 0, moved.id)
      // Filing something into a shut group would look like losing it, so the
      // group opens to show where it went.
      expandFolder(destination.folderId)
    }

    const layout: SidebarLayout = { folders: [], workspaces: [] }
    rootKeys.forEach((key, position) => {
      const id = key.slice(2)
      if (key.startsWith("f:")) layout.folders.push({ id, position })
      else layout.workspaces.push({ id, folder_id: null, position })
    })
    for (const [folderId, ids] of children) {
      ids.forEach((id, position) =>
        layout.workspaces.push({ id, folder_id: folderId, position })
      )
    }

    if (!changesAnything(layout, workspaces, folders)) return
    saveLayout.mutate(layout, {
      onError: (err) =>
        toast.error(
          err instanceof Error ? err.message : "Couldn't save the new order"
        ),
    })
  }

  const drop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    const dragged = drag
    const dropTarget = target
    endDrag()
    if (dragged && dropTarget) move(dragged, dropTarget)
  }

  /**
   * The same refiling, without a drag: a pointer gesture is the natural way to
   * do this and the only way on a touch screen (HTML5 drag doesn't exist there),
   * so the row's menu offers the destinations by name. Lands at the end of
   * wherever it's sent — the menu picks a group, not a slot.
   */
  const moveToFolder = (workspaceId: string, folderId: string | null) =>
    move(
      { kind: "workspace", id: workspaceId },
      folderId === null
        ? { kind: "root", beforeKey: null }
        : { kind: "folder", folderId, beforeId: null }
    )

  /** Aim at the gap above or below a root row — or inside it, if it's a group. */
  const overRootRow = (index: number) => (event: DragEvent<HTMLElement>) => {
    if (!drag) return
    event.preventDefault()
    event.stopPropagation()
    const row = rows[index]
    const into = row.kind === "folder" && drag.kind === "workspace"
    const where = edge(event, into)
    if (where === "into" && row.kind === "folder") {
      setTarget({ kind: "folder", folderId: row.folder.id, beforeId: null })
      return
    }
    const at = where === "before" ? index : index + 1
    setTarget({ kind: "root", beforeKey: rows[at]?.key ?? null })
  }

  /** Aim at the gap above or below a workspace already inside a group. */
  const overChildRow =
    (folderId: string, children: Workspace[], index: number) =>
    (event: DragEvent<HTMLElement>) => {
      if (!drag) return
      event.preventDefault()
      event.stopPropagation()
      if (drag.kind === "folder") {
        // A group passing over another group's contents is heading for the gap
        // after that group, not into it.
        const owner = rows.findIndex(
          (row) => row.kind === "folder" && row.folder.id === folderId
        )
        setTarget({ kind: "root", beforeKey: rows[owner + 1]?.key ?? null })
        return
      }
      const at = edge(event, false) === "before" ? index : index + 1
      setTarget({
        kind: "folder",
        folderId,
        beforeId: children[at]?.id ?? null,
      })
    }

  const dragOf = (
    ref: DragRef,
    dropBefore: boolean,
    onDragOver: (event: DragEvent<HTMLElement>) => void
  ): RowDrag => ({
    onDragStart: startDrag(ref),
    onDragEnd: endDrag,
    onDragOver,
    onDrop: drop,
    dropBefore,
    dragging: drag?.kind === ref.kind && drag.id === ref.id,
  })

  if (isLoading) {
    return (
      <p className="px-2 py-1.5 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
        Loading…
      </p>
    )
  }

  if (rows.length === 0) {
    return (
      <p className="px-2 py-1.5 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
        No workspaces yet.
      </p>
    )
  }

  return (
    <>
      {rows.map((row, index) => {
        if (row.kind === "workspace") {
          const ws = row.workspace
          return (
            <WorkspaceRow
              key={row.key}
              workspaceId={ws.id}
              name={ws.name}
              isSystem={ws.is_system}
              isOpen={openWorkspaces.has(ws.id)}
              isActive={activeWorkspaceId === ws.id}
              isSelected={selection.isWorkspaceSelected(ws.id)}
              selection={selection}
              onSelect={(mods) =>
                selection.selectWorkspace(ws.id, mods, orderedWorkspaceIds)
              }
              activeThreadId={activeThreadId}
              activeRuns={activeRuns}
              onToggle={() => onToggleWorkspace(ws.id)}
              onNewConversation={() => onNewConversation(ws.id)}
              onNavigate={onNavigate}
              onRename={onRenameThread}
              onDelete={onDeleteThread}
              onRenameWorkspace={() => onRenameWorkspace(ws)}
              onDeleteWorkspace={() => onDeleteWorkspace(ws)}
              onCloneWorkspace={() => onCloneWorkspace(ws)}
              drag={dragOf(
                { kind: "workspace", id: ws.id },
                target?.kind === "root" && target.beforeKey === row.key,
                overRootRow(index)
              )}
              moveTo={{
                folders,
                currentFolderId: null,
                onMove: (folderId) => moveToFolder(ws.id, folderId),
              }}
            />
          )
        }

        const isOpen = !collapsed.has(row.folder.id)
        const unread = row.children.reduce(
          (total, child) => total + (unreadByWorkspace.get(child.id) ?? 0),
          0
        )
        return (
          <FolderRow
            key={row.key}
            folder={row.folder}
            workspaceCount={row.children.length}
            unread={unread}
            isOpen={isOpen}
            onToggle={() => toggleFolder(row.folder.id)}
            onRename={() => onRenameFolder(row.folder)}
            onDelete={() => onDeleteFolder(row.folder)}
            drag={dragOf(
              { kind: "folder", id: row.folder.id },
              target?.kind === "root" && target.beforeKey === row.key,
              overRootRow(index)
            )}
            isDropInto={
              target?.kind === "folder" &&
              target.folderId === row.folder.id &&
              target.beforeId === null
            }
          >
            {isOpen ? (
              row.children.length === 0 ? (
                <li
                  className="px-2 py-1 text-[11px] text-muted-foreground"
                  onDragOver={(event) => {
                    if (!drag || drag.kind === "folder") return
                    event.preventDefault()
                    event.stopPropagation()
                    setTarget({
                      kind: "folder",
                      folderId: row.folder.id,
                      beforeId: null,
                    })
                  }}
                  onDrop={drop}
                >
                  Empty — drag a workspace in
                </li>
              ) : (
                row.children.map((ws, childIndex) => (
                  <WorkspaceRow
                    key={ws.id}
                    workspaceId={ws.id}
                    name={ws.name}
                    isSystem={ws.is_system}
                    isOpen={openWorkspaces.has(ws.id)}
                    isActive={activeWorkspaceId === ws.id}
                    isSelected={selection.isWorkspaceSelected(ws.id)}
                    selection={selection}
                    onSelect={(mods) =>
                      selection.selectWorkspace(ws.id, mods, orderedWorkspaceIds)
                    }
                    activeThreadId={activeThreadId}
                    activeRuns={activeRuns}
                    onToggle={() => onToggleWorkspace(ws.id)}
                    onNewConversation={() => onNewConversation(ws.id)}
                    onNavigate={onNavigate}
                    onRename={onRenameThread}
                    onDelete={onDeleteThread}
                    onRenameWorkspace={() => onRenameWorkspace(ws)}
                    onDeleteWorkspace={() => onDeleteWorkspace(ws)}
                    onCloneWorkspace={() => onCloneWorkspace(ws)}
                    drag={dragOf(
                      { kind: "workspace", id: ws.id },
                      target?.kind === "folder" &&
                        target.folderId === row.folder.id &&
                        target.beforeId === ws.id,
                      overChildRow(row.folder.id, row.children, childIndex)
                    )}
                    moveTo={{
                      folders,
                      currentFolderId: row.folder.id,
                      onMove: (folderId) => moveToFolder(ws.id, folderId),
                    }}
                  />
                ))
              )
            ) : null}
          </FolderRow>
        )
      })}

      {/* The gap under the last row. Only a target mid-drag, so it never eats a
          click, and it's what makes "put this at the very bottom" reachable when
          the list ends in an open group. */}
      <li
        aria-hidden
        className={cn("relative", drag ? "h-6" : "h-0")}
        onDragOver={(event) => {
          if (!drag) return
          event.preventDefault()
          setTarget({ kind: "root", beforeKey: null })
        }}
        onDrop={drop}
      >
        {drag && target?.kind === "root" && target.beforeKey === null ? (
          <DropLine />
        ) : null}
      </li>
    </>
  )
}

interface FolderRowProps {
  folder: WorkspaceFolder
  workspaceCount: number
  /** Conversations inside this group that finished unread. */
  unread: number
  isOpen: boolean
  onToggle: () => void
  onRename: () => void
  onDelete: () => void
  drag: RowDrag
  /** A drop would file the dragged workspace into this group. */
  isDropInto: boolean
  children: ReactNode
}

/**
 * A group header. Carries a caret rather than a folder glyph — the workspaces
 * inside it wear those — plus, while shut, what it's hiding: how many
 * workspaces, and whether any of them has a reply you haven't read.
 */
function FolderRow({
  folder,
  workspaceCount,
  unread,
  isOpen,
  onToggle,
  onRename,
  onDelete,
  drag,
  isDropInto,
  children,
}: FolderRowProps) {
  return (
    <SidebarMenuItem className="relative">
      <div
        className={cn("relative", drag.dragging && "opacity-40")}
        draggable
        onDragStart={drag.onDragStart}
        onDragEnd={drag.onDragEnd}
        onDragOver={drag.onDragOver}
        onDrop={drag.onDrop}
      >
        {drag.dropBefore ? <DropLine /> : null}
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <SidebarMenuButton
              onClick={onToggle}
              tooltip={folder.name}
              aria-expanded={isOpen}
              className={cn(
                "select-none text-sidebar-foreground/80",
                isDropInto && "bg-primary/10 ring-1 ring-primary"
              )}
            >
              {isOpen ? (
                <CaretDown className="size-4" />
              ) : (
                <CaretRight className="size-4" />
              )}
              <span className="flex-1 truncate font-medium">{folder.name}</span>
              {unread > 0 ? (
                <span
                  className="size-1.5 shrink-0 rounded-full bg-success"
                  title={`${unread} unread conversation${unread > 1 ? "s" : ""}`}
                  aria-label={`${unread} unread conversation${
                    unread > 1 ? "s" : ""
                  }`}
                />
              ) : null}
              {!isOpen && workspaceCount > 0 ? (
                <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
                  {workspaceCount}
                </span>
              ) : null}
            </SidebarMenuButton>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem onSelect={onRename}>
              <Pencil className="size-4" />
              Rename
            </ContextMenuItem>
            <ContextMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={onDelete}
            >
              <Trash className="size-4" />
              Delete folder
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>

      {isOpen ? (
        <ul className="ml-3.5 mt-1 flex min-w-0 flex-col gap-1 border-l border-sidebar-border pl-1.5 group-data-[collapsible=icon]:ml-0 group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:pl-0">
          {children}
        </ul>
      ) : null}
    </SidebarMenuItem>
  )
}

/**
 * Fold the two flat lists into the shape the sidebar draws: the root sequence
 * with each group's members attached. Position orders siblings, creation breaks
 * ties, and a workspace pointing at a folder that's gone shows up at the root
 * rather than vanishing.
 */
function buildRows(
  workspaces: Workspace[],
  folders: WorkspaceFolder[]
): TreeRow[] {
  const known = new Set(folders.map((folder) => folder.id))
  const grouped = new Map<string, Workspace[]>()
  const loose: Workspace[] = []
  for (const ws of workspaces) {
    if (ws.folder_id && known.has(ws.folder_id)) {
      const members = grouped.get(ws.folder_id)
      if (members) members.push(ws)
      else grouped.set(ws.folder_id, [ws])
    } else {
      loose.push(ws)
    }
  }

  const byPosition = (a: { position: number; created_at: string }, b: typeof a) =>
    a.position - b.position || a.created_at.localeCompare(b.created_at)

  for (const members of grouped.values()) members.sort(byPosition)

  const rows: TreeRow[] = [
    ...folders.map(
      (folder): TreeRow => ({
        kind: "folder",
        key: folderKey(folder.id),
        folder,
        children: grouped.get(folder.id) ?? [],
      })
    ),
    ...loose.map(
      (workspace): TreeRow => ({
        kind: "workspace",
        key: workspaceKey(workspace.id),
        workspace,
      })
    ),
  ]
  return rows.sort((a, b) =>
    byPosition(
      a.kind === "folder" ? a.folder : a.workspace,
      b.kind === "folder" ? b.folder : b.workspace
    )
  )
}

/** Did the drop actually move anything, or did the row land back where it was? */
function changesAnything(
  layout: SidebarLayout,
  workspaces: Workspace[],
  folders: WorkspaceFolder[]
): boolean {
  const folderById = new Map(folders.map((folder) => [folder.id, folder]))
  if (
    layout.folders.some(
      (placement) => folderById.get(placement.id)?.position !== placement.position
    )
  ) {
    return true
  }
  const wsById = new Map(workspaces.map((ws) => [ws.id, ws]))
  return layout.workspaces.some((placement) => {
    const ws = wsById.get(placement.id)
    if (!ws) return true
    return (
      ws.position !== placement.position ||
      (ws.folder_id ?? null) !== placement.folder_id
    )
  })
}
