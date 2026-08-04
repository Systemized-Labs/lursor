import { Fragment } from "react"
import { ArrowLeft, FolderPlus, Plus } from "@phosphor-icons/react"

import type { Thread, Workspace } from "@/api/types"
import { Button } from "@/components/ui/button"
import { FolderRow } from "@/components/layout/sessions/folder-row"
import { ProjectRow } from "@/components/layout/sessions/project-row"
import { useTreeDrag } from "@/components/layout/sessions/use-tree-drag"
import { WorkspaceConversations } from "@/components/layout/panel/workspace-conversations"
import type { ConversationHandlers } from "@/components/layout/panel/types"
import type { WorkspaceDialogs } from "@/components/layout/workspace-dialogs"
import type { WorkspaceIcons } from "@/components/layout/use-workspace-icons"
import type { WorkspaceTree } from "@/components/layout/use-workspace-tree"
import type { WorkspaceStatus } from "@/components/layout/use-workspace-status"
import { cn } from "@/lib/utils"

/** How many of a project's sessions show inline beneath it, undrilled. */
const INLINE_SESSIONS = 6

interface ProjectsSectionProps {
  tree: WorkspaceTree
  /** The Skill Studio, pinned below the rest; it is a workspace with an icon. */
  studio: Workspace | undefined
  icons: WorkspaceIcons
  status: WorkspaceStatus
  activeWorkspaceId: string | undefined
  /** Conversations for a workspace, newest-first. */
  threadsFor: (workspaceId: string) => Thread[]
  threadsLoading: boolean
  hrefFor: (workspaceId: string) => string
  onOpenWorkspace: (workspaceId: string) => void
  onNewConversation: (workspaceId: string) => void
  dialogs: WorkspaceDialogs
  handlers: ConversationHandlers
  /** Drill-down: which project the section is scoped to, and how to change it. */
  drilledId: string | null
  onDrillInto: (workspaceId: string) => void
  onDrillOut: () => void
}

/**
 * The PROJECTS section: every project, its folders, and the sessions inside.
 *
 * Two shapes. **Undrilled**, it is the list of projects, with the active one's
 * most recent sessions inline beneath it — which is what the reference
 * screenshot shows, and it means the thing you are working on is always two rows
 * from the thing you are working *in*. **Drilled**, one project fills the
 * section: its name becomes the heading, `← All projects` goes back, and every
 * session is listed rather than the first {@link INLINE_SESSIONS}.
 *
 * The drill is sidebar state, not a route (see `use-sessions-view`). Opening a
 * session navigates, and a route-derived scope would drop you back out to the
 * list under the cursor.
 */
export function ProjectsSection({
  tree,
  studio,
  icons,
  status,
  activeWorkspaceId,
  threadsFor,
  threadsLoading,
  hrefFor,
  onOpenWorkspace,
  onNewConversation,
  dialogs,
  handlers,
  drilledId,
  onDrillInto,
  onDrillOut,
}: ProjectsSectionProps) {
  const drag = useTreeDrag(tree)

  const folderTargets = tree.folders.map((folder) => ({
    id: folder.id,
    name: folder.name,
  }))

  /** One project row, wherever it sits. */
  const row = (
    workspace: Workspace,
    slot: number,
    target: Parameters<typeof drag.rowDrag>[1],
    nested: boolean
  ) => {
    const { running, unread } = status(workspace.id)
    return (
      <ProjectRow
        key={workspace.id}
        workspace={workspace}
        slot={slot}
        href={hrefFor(workspace.id)}
        icon={icons.iconFor(workspace)}
        hasIconOverride={icons.hasOverride(workspace.id)}
        isActive={activeWorkspaceId === workspace.id}
        running={running}
        unreadCount={unread}
        nested={nested}
        folders={folderTargets}
        onOpen={() => {
          onOpenWorkspace(workspace.id)
          onDrillInto(workspace.id)
        }}
        onSetIcon={(key) => icons.setIcon(workspace.id, key)}
        onMoveToFolder={(folderId) =>
          tree.moveToFolder(workspace.id, folderId)
        }
        onNewConversation={() => onNewConversation(workspace.id)}
        onRename={() => dialogs.openRenameWorkspace(workspace)}
        onClone={() => dialogs.openCloneWorkspace(workspace)}
        onDelete={() => dialogs.openDeleteWorkspace(workspace)}
        drag={drag.rowDrag({ kind: "workspace", id: workspace.id }, target)}
      />
    )
  }

  /** The active project's sessions, inline under its row. */
  const inlineSessions = (workspaceId: string) => {
    if (workspaceId !== activeWorkspaceId) return null
    const threads = threadsFor(workspaceId)
    return (
      <li key={`sessions-${workspaceId}`} className="min-w-0 pl-3">
        <WorkspaceConversations
          threads={threads.slice(0, INLINE_SESSIONS)}
          isLoading={threadsLoading}
          emptyLabel="No sessions yet"
          {...handlers}
        />
        {threads.length > INLINE_SESSIONS ? (
          <button
            type="button"
            onClick={() => onDrillInto(workspaceId)}
            className="w-full rounded-md px-2.5 py-1 text-left text-[11px] text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            {threads.length - INLINE_SESSIONS} more…
          </button>
        ) : null}
      </li>
    )
  }

  // ── Drilled: one project fills the section ────────────────────────────────
  const drilled = drilledId
    ? (tree.ordered.find((w) => w.id === drilledId) ??
      (studio?.id === drilledId ? studio : undefined))
    : undefined

  if (drilled) {
    const threads = threadsFor(drilled.id)
    const Icon = icons.iconFor(drilled).Icon
    return (
      <section className="flex min-w-0 flex-col px-2">
        <button
          type="button"
          onClick={onDrillOut}
          className="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 text-[11px] text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <ArrowLeft className="size-3 shrink-0" />
          All projects
        </button>

        <div className="flex h-7 min-w-0 items-center gap-1.5 px-1.5">
          <Icon className="size-4 shrink-0 text-sidebar-foreground/70" />
          <h2
            className="min-w-0 flex-1 truncate text-[12px] font-medium text-sidebar-foreground"
            title={drilled.name}
          >
            {drilled.name}
          </h2>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onNewConversation(drilled.id)}
            aria-label="New session"
            title="New session"
            className="size-6 text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <Plus className="size-3.5" />
          </Button>
        </div>

        <WorkspaceConversations
          threads={threads}
          isLoading={threadsLoading}
          emptyLabel="No sessions yet"
          {...handlers}
        />
      </section>
    )
  }

  // ── Undrilled: the whole list ─────────────────────────────────────────────
  return (
    <section className="flex min-w-0 flex-col px-2">
      <SectionHeading label="Projects">
        <Button
          variant="ghost"
          size="icon"
          onClick={dialogs.openNewFolder}
          aria-label="New folder"
          title="New folder"
          className="size-5 text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <FolderPlus className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={dialogs.openNewWorkspace}
          aria-label="New project"
          title="New project"
          className="size-5 text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <Plus className="size-3.5" />
        </Button>
      </SectionHeading>

      <ul className="flex min-w-0 flex-col">
        {tree.nodes.map((node, rootIndex) => {
          if (node.kind === "workspace") {
            return (
              <Fragment key={node.workspace.id}>
                {row(
                  node.workspace,
                  node.slot,
                  { kind: "root", index: rootIndex },
                  false
                )}
                {inlineSessions(node.workspace.id)}
              </Fragment>
            )
          }

          const { folder, children, collapsed } = node
          // A shut group still shows the project you are in.
          const visible = collapsed
            ? children.filter((c) => c.workspace.id === activeWorkspaceId)
            : children
          const rollup = children.reduce(
            (acc, { workspace }) => {
              const { running, unread } = status(workspace.id)
              return {
                running: acc.running || running,
                unread: acc.unread + unread,
              }
            },
            { running: false, unread: 0 }
          )

          return (
            <FolderRow
              key={folder.id}
              folder={folder}
              collapsed={collapsed}
              childCount={children.length}
              running={rollup.running}
              unreadCount={rollup.unread}
              containsActive={children.some(
                (c) => c.workspace.id === activeWorkspaceId
              )}
              onToggle={() => tree.toggleFolder(folder.id)}
              onRename={() => dialogs.openRenameFolder(folder)}
              onDelete={() => dialogs.openDeleteFolder(folder)}
              isFileTarget={drag.fileInto === folder.id}
              drag={{
                ...drag.rowDrag(
                  { kind: "folder", id: folder.id },
                  { kind: "root", index: rootIndex }
                ),
                // A workspace dropped on the header goes *inside*; only another
                // group reorders against it. Same gesture, different meaning,
                // decided by what is in your hand.
                onDragOver: (event) => {
                  if (!drag.dragged) return
                  event.preventDefault()
                  if (drag.dragged.kind === "workspace") {
                    drag.setFileInto(folder.id)
                    drag.setDropTarget(null)
                  } else {
                    drag.setDropTarget({ kind: "root", index: rootIndex })
                    drag.setFileInto(null)
                  }
                },
                onDrop: (event) => {
                  event.preventDefault()
                  if (drag.dragged?.kind === "workspace") {
                    tree.move(drag.dragged, {
                      kind: "folder",
                      folderId: folder.id,
                      index: children.length,
                    })
                  } else if (drag.dragged && drag.dragged.id !== folder.id) {
                    tree.move(drag.dragged, { kind: "root", index: rootIndex })
                  }
                  drag.end()
                },
              }}
            >
              {visible.map(({ workspace, slot }) => (
                <Fragment key={workspace.id}>
                  {row(
                    workspace,
                    slot,
                    {
                      kind: "folder",
                      folderId: folder.id,
                      index: children.findIndex(
                        (c) => c.workspace.id === workspace.id
                      ),
                    },
                    true
                  )}
                  {inlineSessions(workspace.id)}
                </Fragment>
              ))}
              {/* An open group needs a floor to drop onto, or its last slot is
                  unreachable: every row above hands you the space *before* it. */}
              {drag.active && !collapsed && drag.dragged?.kind === "workspace" ? (
                <DropFloor
                  active={drag.isDropTarget({
                    kind: "folder",
                    folderId: folder.id,
                    index: children.length,
                  })}
                  onOver={() => {
                    drag.setDropTarget({
                      kind: "folder",
                      folderId: folder.id,
                      index: children.length,
                    })
                    drag.setFileInto(null)
                  }}
                  onDrop={() => {
                    if (drag.dragged) {
                      tree.move(drag.dragged, {
                        kind: "folder",
                        folderId: folder.id,
                        index: children.length,
                      })
                    }
                    drag.end()
                  }}
                />
              ) : null}
            </FolderRow>
          )
        })}

        {/* The same floor for the top level, which is also how a project gets
            back out of a group when every root row is above it. */}
        {drag.active ? (
          <DropFloor
            active={drag.isDropTarget({
              kind: "root",
              index: tree.nodes.length,
            })}
            onOver={() => {
              drag.setDropTarget({ kind: "root", index: tree.nodes.length })
              drag.setFileInto(null)
            }}
            onDrop={() => {
              if (drag.dragged) {
                tree.move(drag.dragged, {
                  kind: "root",
                  index: tree.nodes.length,
                })
              }
              drag.end()
            }}
          />
        ) : null}

        {/* The studio is app-owned and can't be deleted, reordered or filed, so
            it sits below the ones that can, behind a divider. */}
        {studio ? (
          <Fragment key={`studio-${studio.id}`}>
            <li aria-hidden className="mx-2 my-1 h-px shrink-0 bg-sidebar-border" />
            {row(studio, 0, { kind: "root", index: tree.nodes.length }, false)}
            {inlineSessions(studio.id)}
          </Fragment>
        ) : null}
      </ul>

      {tree.nodes.length === 0 && !studio ? (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">
          No projects yet.
        </p>
      ) : null}
    </section>
  )
}

/** A section heading with room for its own actions on the same row. */
export function SectionHeading({
  label,
  children,
}: {
  label: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex h-7 min-w-0 items-center gap-1 px-1.5 pt-1">
      {/* A ledger label, not a page title: in a 256px column the thing you read
          is the list, not the word naming it. */}
      <h2 className="min-w-0 flex-1 truncate text-[10px] font-medium uppercase tracking-[0.1em] text-sidebar-foreground/55">
        {label}
      </h2>
      {children}
    </div>
  )
}

function DropFloor({
  active,
  onOver,
  onDrop,
}: {
  active: boolean
  onOver: () => void
  onDrop: () => void
}) {
  return (
    <li
      aria-hidden
      onDragOver={(event) => {
        event.preventDefault()
        onOver()
      }}
      onDrop={(event) => {
        event.preventDefault()
        onDrop()
      }}
      className={cn(
        "h-3 shrink-0 rounded",
        active && "bg-sidebar-primary/20 ring-1 ring-inset ring-sidebar-primary"
      )}
    />
  )
}
