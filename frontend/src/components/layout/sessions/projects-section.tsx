import { Fragment } from "react"
import { ArrowLeft, FolderPlus, Plus } from "@phosphor-icons/react"

import type { Thread, Workspace } from "@/api/types"
import { Button } from "@/components/ui/button"
import { FolderRow } from "@/components/layout/sessions/folder-row"
import { ProjectRow } from "@/components/layout/sessions/project-row"
import { useTreeDrag } from "@/components/layout/sessions/use-tree-drag"
import { WorkspaceConversations } from "@/components/layout/sessions/workspace-conversations"
import type { ConversationHandlers } from "@/components/layout/sessions/types"
import { useCollapsedProjects } from "@/components/layout/use-collapsed-projects"
import type { WorkspaceDialogs } from "@/components/layout/workspace-dialogs"
import type { WorkspaceIcons } from "@/components/layout/use-workspace-icons"
import type { WorkspaceTree } from "@/components/layout/use-workspace-tree"
import type { WorkspaceStatus } from "@/components/layout/use-workspace-status"
import { cn } from "@/lib/utils"

/**
 * How many of a project's sessions show inline beneath it, undrilled.
 *
 * Four, because every project shows them now rather than only the active one: at
 * six, three busy projects fill the column and the fourth project name is below
 * the fold. Four is a recognisable slice — the ones you would have gone looking
 * for — and the whole list is one click away on the project's name.
 *
 * The slice is silent about what it left out. A `N more…` row said so explicitly
 * and was cut: it spent a row per project restating the cap, and it pointed at the
 * drill, which the project name above it already does.
 */
const INLINE_SESSIONS = 4

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
 * Two shapes, and they are the sidebar's two modes of working.
 *
 * **Undrilled** is the list of projects with each one's most recent sessions
 * inline beneath it — every project's, not just the active one's. That is the
 * whole point of the top level: the sessions you would hop between are already on
 * screen, in the project that explains them, so crossing from one repo's
 * conversation to another's costs one click. It is also what replaced the
 * Activity feed, which showed the same rows in time order but only as a mode you
 * had to leave the projects to enter. A project's caret shuts its sessions here
 * (`use-collapsed-projects`, remembered), which is how a list of twenty repos
 * stays a list you can read.
 *
 * **Drilled**, one project fills the section: its name becomes the heading,
 * `← All projects` goes back, and every session is listed rather than the first
 * {@link INLINE_SESSIONS}. That is the mode for working *in* a project, where the
 * other fifteen repos are noise. Collapsing is ignored here — you asked for this
 * project specifically, so a shut caret from last week shouldn't answer with an
 * empty pane.
 *
 * The drill is sidebar state, not a route (see `use-project-drill`). Opening a
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
  // Section-local, like the drag state: nothing outside this list cares which
  // projects are shut, and the answer survives a remount in localStorage anyway.
  const collapsedProjects = useCollapsedProjects()

  const folderTargets = tree.folders.map((folder) => ({
    id: folder.id,
    name: folder.name,
  }))

  /** One project row, wherever it sits. */
  const row = (
    workspace: Workspace,
    target: Parameters<typeof drag.rowDrag>[1],
    nested: boolean
  ) => {
    const { running } = status(workspace.id)
    // No caret on a project with nothing to show: an arrow that toggles between
    // empty and empty is a control that lies about having an effect.
    const hasSessions = !threadsLoading && threadsFor(workspace.id).length > 0
    return (
      <ProjectRow
        key={workspace.id}
        workspace={workspace}
        href={hrefFor(workspace.id)}
        icon={icons.iconFor(workspace)}
        hasIconOverride={icons.hasOverride(workspace.id)}
        isActive={activeWorkspaceId === workspace.id}
        running={running}
        nested={nested}
        collapsed={collapsedProjects.isCollapsed(workspace.id)}
        onToggleCollapsed={
          hasSessions ? () => collapsedProjects.toggle(workspace.id) : undefined
        }
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

  /** A project's most recent sessions, inline under its row. */
  const inlineSessions = (workspaceId: string) => {
    const threads = threadsFor(workspaceId)
    // Nothing at all for a project with no sessions, and nothing while the list
    // is still loading. Both used to render a line of text, which was right when
    // one project at a time showed its sessions and reads as noise now that all
    // of them do: a column of "No sessions yet" says nothing, and a project with
    // an empty gap under it is already legible as empty.
    if (threadsLoading || threads.length === 0) return null
    if (collapsedProjects.isCollapsed(workspaceId)) return null
    return (
      <li key={`sessions-${workspaceId}`} className="min-w-0 pl-3">
        <WorkspaceConversations
          threads={threads.slice(0, INLINE_SESSIONS)}
          isLoading={false}
          {...handlers}
        />
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
                {row(node.workspace, { kind: "root", index: rootIndex }, false)}
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
              {visible.map(({ workspace }) => (
                <Fragment key={workspace.id}>
                  {row(
                    workspace,
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
            {row(studio, { kind: "root", index: tree.nodes.length }, false)}
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
