import {
  ChartBar,
  ChatCentered,
  Cpu,
  Folder,
  FolderOpen,
  FolderPlus,
  Gear,
  GitBranch,
  MagnifyingGlass,
  NotePencil,
  Palette,
  Pencil,
  Plus,
  SlidersHorizontal,
  Trash,
  X,
} from "@phosphor-icons/react"
import {
  type ComponentType,
  type MouseEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  Link,
  matchPath,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import type { Thread, Workspace } from "@/api/types"
import {
  threadKeys,
  threadsApi,
  useActiveRuns,
  useThreads,
  useUpdateThread,
} from "@/api/threads"
import {
  useDeleteWorkspace,
  useUpdateWorkspace,
  useWorkspaces,
  workspaceKeys,
  workspacesApi,
} from "@/api/workspaces"
import { useGitHubConfig } from "@/api/github"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { DotGridLoader } from "@/components/ui/dot-grid-loader"
import { Input } from "@/components/ui/input"
import {
  markThreadRead,
  seedThreadRead,
  useThreadReads,
} from "@/hooks/use-thread-reads"
import { useOptimisticRuns } from "@/hooks/use-optimistic-runs"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { ThemePicker } from "@/components/ui/theme-picker"
import { WorkspaceFormDialog } from "@/pages/workspaces/workspace-form-dialog"
import { CloneIntoWorkspaceDialog } from "@/pages/workspaces/clone-into-workspace-dialog"
import { useCommandPalette } from "@/components/command-palette/command-palette"
import {
  type SelectMods,
  type SidebarSelection,
  useSidebarSelection,
} from "@/components/layout/use-sidebar-selection"
import { cn } from "@/lib/utils"
import { isMacElectron } from "@/lib/platform"

interface NavItem {
  to: string
  label: string
  icon: ComponentType<{ className?: string }>
}

const navItems: NavItem[] = [
  { to: "/analytics", label: "Usage", icon: ChartBar },
  { to: "/laios", label: "LAIOS", icon: Cpu },
  { to: "/customization", label: "Customization", icon: SlidersHorizontal },
]

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
 * Cursor-style left navigation: the primary destinations up top, then the
 * workspaces rendered as expandable folders whose conversations nest beneath
 * them. Selecting a conversation drives the chat surface via `?c=<threadId>`.
 */
export function AppSidebar() {
  const { pathname } = useLocation()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { isMobile, setOpenMobile } = useSidebar()
  const { open: openCommandPalette } = useCommandPalette()
  const qc = useQueryClient()

  const workspacesQuery = useWorkspaces()
  const githubConfig = useGitHubConfig().data
  const activeRunsQuery = useActiveRuns()
  // Union the polled server runs with locally-optimistic ones so a just-sent
  // message shows "working" instantly, before the 3s poll catches up.
  const optimisticRuns = useOptimisticRuns()
  const activeRuns = useMemo(
    () => new Set([...(activeRunsQuery.data ?? []), ...optimisticRuns]),
    [activeRunsQuery.data, optimisticRuns]
  )

  // When a background run finishes (its id leaves the active set), refresh the
  // thread lists so the sidebar reorders by recency and picks up the new
  // updated_at that drives the "finished, unopened" badge.
  const prevRuns = useRef(activeRuns)
  useEffect(() => {
    const prev = prevRuns.current
    prevRuns.current = activeRuns
    let finished = false
    for (const id of prev) {
      if (!activeRuns.has(id)) {
        finished = true
        break
      }
    }
    if (finished) {
      qc.invalidateQueries({ queryKey: ["threads", "workspace"] })
      // Reconcile the poll now rather than up to 3s later, so a still-running
      // goal loop re-appears promptly after its optimistic flag clears.
      qc.invalidateQueries({ queryKey: threadKeys.activeRuns() })
    }
  }, [activeRuns, qc])

  const chatMatch =
    matchPath("/workspaces/:workspaceId/chat", pathname) ??
    matchPath("/workspaces/:workspaceId", pathname)
  const activeWorkspaceId = chatMatch?.params.workspaceId
  const activeThreadId = searchParams.get("c")

  // Expand/collapse is driven solely by clicking a workspace row; navigating to
  // a conversation never opens its folder.
  const [openWorkspaces, setOpenWorkspaces] = useState<Set<string>>(new Set())

  const [renameTarget, setRenameTarget] = useState<Thread | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<Thread | null>(null)

  const [renameWsTarget, setRenameWsTarget] = useState<WorkspaceTarget | null>(
    null
  )
  const [renameWsValue, setRenameWsValue] = useState("")
  const [deleteWsTarget, setDeleteWsTarget] = useState<WorkspaceTarget | null>(
    null
  )
  const [cloneWsTarget, setCloneWsTarget] = useState<WorkspaceTarget | null>(
    null
  )
  const [workspaceFormOpen, setWorkspaceFormOpen] = useState(false)

  const updateThread = useUpdateThread()
  const deleteThread = useMutation({
    mutationFn: (thread: Thread) => threadsApi.remove(thread.id),
    onSuccess: (_data, thread) => {
      qc.invalidateQueries({ queryKey: threadKeys.byWorkspace(thread.workspace_id) })
    },
  })

  const updateWorkspace = useUpdateWorkspace()
  const deleteWorkspace = useDeleteWorkspace()

  const selection = useSidebarSelection()
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)

  // Esc exits sticky selection mode (unless the confirm dialog owns Esc).
  useEffect(() => {
    if (selection.count === 0 || bulkDeleteOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") selection.clear()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [selection, bulkDeleteOpen])

  const closeMobile = () => {
    if (isMobile) setOpenMobile(false)
  }
  const isNavActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`)

  const toggleWorkspace = (id: string) => {
    setOpenWorkspaces((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const newConversation = (workspaceId: string) => {
    setOpenWorkspaces((prev) =>
      prev.has(workspaceId) ? prev : new Set(prev).add(workspaceId)
    )
    navigate(`/workspaces/${workspaceId}/chat`)
    closeMobile()
  }

  async function handleRename() {
    if (!renameTarget) return
    const title = renameValue.trim()
    if (!title) return
    try {
      await updateThread.mutateAsync({ id: renameTarget.id, input: { title } })
      setRenameTarget(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to rename")
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    const thread = deleteTarget
    try {
      await deleteThread.mutateAsync(thread)
      setDeleteTarget(null)
      // If the open conversation was deleted, fall back to a new one.
      if (activeThreadId === thread.id) {
        navigate(`/workspaces/${thread.workspace_id}/chat`)
      }
      toast.success("Conversation deleted")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete")
    }
  }

  async function handleRenameWorkspace() {
    if (!renameWsTarget) return
    const name = renameWsValue.trim()
    if (!name) return
    try {
      await updateWorkspace.mutateAsync({
        id: renameWsTarget.id,
        input: { name },
      })
      setRenameWsTarget(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to rename")
    }
  }

  function handleDeleteWorkspace() {
    if (!deleteWsTarget) return
    const ws = deleteWsTarget
    // Close the dialog and update the UI immediately; the delete runs in the
    // background with an optimistic cache update (rolled back on failure).
    setDeleteWsTarget(null)
    if (activeWorkspaceId === ws.id) {
      navigate("/customization")
    }
    deleteWorkspace.mutate(ws.id, {
      onSuccess: () => toast.success("Workspace deleted"),
      onError: (err) =>
        toast.error(err instanceof Error ? err.message : "Failed to delete"),
    })
  }

  function handleBulkDelete() {
    // Close the dialog and update the UI immediately; the deletes run in the
    // background with an optimistic cache update (rolled back on failure).
    if (selection.kind === "workspace") {
      const ids = [...selection.workspaceIds]
      const previous = qc.getQueryData<Workspace[]>(workspaceKeys.all)
      qc.setQueryData<Workspace[]>(workspaceKeys.all, (old) =>
        (old ?? []).filter((ws) => !ids.includes(ws.id))
      )
      if (activeWorkspaceId && ids.includes(activeWorkspaceId)) {
        navigate("/customization")
      }
      selection.clear()
      setBulkDeleteOpen(false)
      Promise.all(ids.map((id) => workspacesApi.remove(id)))
        .then(() => {
          toast.success(
            `${ids.length} workspace${ids.length > 1 ? "s" : ""} deleted`
          )
        })
        .catch((err) => {
          if (previous) qc.setQueryData(workspaceKeys.all, previous)
          toast.error(err instanceof Error ? err.message : "Failed to delete")
        })
        .finally(() => qc.invalidateQueries({ queryKey: workspaceKeys.all }))
    } else if (selection.kind === "thread") {
      const threads = [...selection.threads.values()]
      const openDeleted = threads.find((t) => t.id === activeThreadId)
      if (openDeleted) {
        navigate(`/workspaces/${openDeleted.workspace_id}/chat`)
      }
      selection.clear()
      setBulkDeleteOpen(false)
      Promise.all(threads.map((t) => threadsApi.remove(t.id)))
        .then(() => {
          toast.success(
            `${threads.length} conversation${threads.length > 1 ? "s" : ""} deleted`
          )
        })
        .catch((err) => {
          toast.error(err instanceof Error ? err.message : "Failed to delete")
        })
        .finally(() => {
          // Refresh every workspace whose conversations changed.
          for (const wsId of new Set(threads.map((t) => t.workspace_id))) {
            qc.invalidateQueries({ queryKey: threadKeys.byWorkspace(wsId) })
          }
        })
    }
  }

  const workspaces = workspacesQuery.data ?? []
  const orderedWorkspaceIds = workspaces.map((ws) => ws.id)

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader
        className={cn(
          // On macOS Electron the OS traffic lights overlay the top-left, so
          // let the header strip drag the window.
          isMacElectron && "[-webkit-app-region:drag]"
        )}
      >
        {/* On macOS the OS traffic lights overlay the top-left, so reserve a
            drag strip above the logo to clear them. */}
        {isMacElectron && !isMobile && <div className="h-8" />}
        <div className="flex items-center gap-1 group-data-[collapsible=icon]:justify-center">
          <Link
            to="/"
            onClick={closeMobile}
            className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-1 group-data-[collapsible=icon]:hidden [-webkit-app-region:no-drag]"
          >
            <img
              src="/lursor_icon.png"
              alt="Lursor"
              className="size-9 shrink-0 rounded-md object-contain"
            />
            <span className="truncate text-lg font-bold tracking-tight text-foreground">
              Lursor
            </span>
          </Link>
          {/* Explicit close on mobile — the off-canvas sheet's own close is
              hidden, so give the drawer a clear dismiss affordance. */}
          {isMobile && (
            <button
              type="button"
              onClick={() => setOpenMobile(false)}
              aria-label="Close menu"
              className="mr-1 flex size-9 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground [-webkit-app-region:no-drag]"
            >
              <X className="size-5" />
            </button>
          )}
        </div>
      </SidebarHeader>

      <SidebarContent className="overflow-hidden">
        <SidebarGroup className="shrink-0">
          <SidebarGroupLabel>Platform</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={pathname === "/"}
                  tooltip="New Chat"
                  asChild
                >
                  <Link to="/" onClick={closeMobile}>
                    <NotePencil className="size-4" />
                    <span>New Chat</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  tooltip="Search"
                  onClick={() => {
                    openCommandPalette()
                    closeMobile()
                  }}
                  className="group/search"
                >
                  <MagnifyingGlass className="size-4" />
                  <span className="flex-1">Search</span>
                  <kbd className="ml-auto text-[10px] font-medium text-muted-foreground opacity-0 transition-opacity group-hover/search:opacity-100 group-data-[collapsible=icon]:hidden">
                    ⌘K
                  </kbd>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    isActive={isNavActive(item.to)}
                    tooltip={item.label}
                    asChild
                  >
                    <Link to={item.to} onClick={closeMobile}>
                      <item.icon className="size-4" />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="flex min-h-0 flex-1 flex-col">
          <div className="group/workspaces flex items-center">
            <SidebarGroupLabel className="flex-1">Workspaces</SidebarGroupLabel>
            <button
              type="button"
              onClick={() => setWorkspaceFormOpen(true)}
              title="New workspace"
              aria-label="New workspace"
              className="mr-1 flex size-5 items-center justify-center rounded-md text-sidebar-foreground/70 opacity-0 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:opacity-100 group-hover/workspaces:opacity-100 group-data-[collapsible=icon]:hidden"
            >
              <FolderPlus className="size-4" />
            </button>
          </div>

          {/* Bulk-selection toolbar — appears once ⌘/⇧-click selects items.
              While it's showing, plain clicks toggle selection (sticky mode);
              "Done" or Esc exits back to normal navigation. */}
          {selection.count > 0 ? (
            <div className="mx-1 mb-1 flex items-center gap-1 rounded-md border border-sidebar-border bg-sidebar-accent/50 px-2 py-1 group-data-[collapsible=icon]:hidden">
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
              <button
                type="button"
                onClick={() => setBulkDeleteOpen(true)}
                title="Delete selected"
                aria-label="Delete selected"
                className="flex size-6 items-center justify-center rounded-md text-destructive hover:bg-destructive/10"
              >
                <Trash className="size-4" />
              </button>
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
          <SidebarGroupContent className="scrollbar-hover min-h-0 flex-1 overflow-y-auto group-data-[collapsible=icon]:overflow-hidden">
            <SidebarMenu>
              {workspacesQuery.isLoading ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
                  Loading…
                </p>
              ) : workspaces.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
                  No workspaces yet.
                </p>
              ) : (
                workspaces.map((ws) => (
                  <WorkspaceRow
                    key={ws.id}
                    workspaceId={ws.id}
                    name={ws.name}
                    isOpen={openWorkspaces.has(ws.id)}
                    isActive={activeWorkspaceId === ws.id}
                    isSelected={selection.isWorkspaceSelected(ws.id)}
                    selection={selection}
                    onSelect={(mods) =>
                      selection.selectWorkspace(ws.id, mods, orderedWorkspaceIds)
                    }
                    activeThreadId={activeThreadId}
                    activeRuns={activeRuns}
                    onToggle={() => toggleWorkspace(ws.id)}
                    onNewConversation={() => newConversation(ws.id)}
                    onNavigate={closeMobile}
                    onRename={(t) => {
                      setRenameTarget(t)
                      setRenameValue(t.title)
                    }}
                    onDelete={setDeleteTarget}
                    onRenameWorkspace={() => {
                      setRenameWsTarget({ id: ws.id, name: ws.name })
                      setRenameWsValue(ws.name)
                    }}
                    onDeleteWorkspace={() =>
                      setDeleteWsTarget({ id: ws.id, name: ws.name })
                    }
                    onCloneWorkspace={() =>
                      setCloneWsTarget({ id: ws.id, name: ws.name })
                    }
                  />
                ))
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="flex items-center gap-2 rounded-md px-1.5 py-1 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
              {/* GitHub identity. The avatar links to Settings so it stays a
                  reachable target even when the sidebar collapses to icons. */}
              <Link
                to="/settings"
                onClick={closeMobile}
                aria-label="Settings"
                className="shrink-0"
              >
                {githubConfig?.avatar_url ? (
                  <img
                    src={githubConfig.avatar_url}
                    alt=""
                    className="size-8 rounded-full border border-sidebar-border object-cover"
                  />
                ) : (
                  <div className="flex size-8 items-center justify-center rounded-full border border-sidebar-border bg-sidebar-accent text-sidebar-accent-foreground">
                    <GitBranch className="size-4" />
                  </div>
                )}
              </Link>
              <div className="min-w-0 flex-1 leading-tight group-data-[collapsible=icon]:hidden">
                <p className="truncate text-sm font-medium text-sidebar-foreground">
                  {githubConfig?.name || githubConfig?.login || "Not connected"}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {githubConfig?.login ? `@${githubConfig.login}` : "GitHub"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-0.5 group-data-[collapsible=icon]:hidden">
                <ThemePicker
                  trigger={(open) => (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-sidebar-foreground/70 hover:text-sidebar-accent-foreground"
                      aria-label="Choose theme"
                      onClick={open}
                    >
                      <Palette className="size-4" />
                      <span className="sr-only">Choose theme</span>
                    </Button>
                  )}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-sidebar-foreground/70 hover:text-sidebar-accent-foreground"
                  aria-label="Settings"
                  asChild
                >
                  <Link to="/settings" onClick={closeMobile}>
                    <Gear className="size-4" />
                  </Link>
                </Button>
              </div>
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />

      {/* New workspace dialog */}
      <WorkspaceFormDialog
        open={workspaceFormOpen}
        onOpenChange={setWorkspaceFormOpen}
      />

      {/* Rename dialog */}
      <Dialog
        open={Boolean(renameTarget)}
        onOpenChange={(open) => !open && setRenameTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename conversation</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                void handleRename()
              }
            }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => void handleRename()}
              disabled={updateThread.isPending || !renameValue.trim()}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete conversation"
        description={
          deleteTarget
            ? `This will permanently delete "${deleteTarget.title || "this conversation"}".`
            : undefined
        }
        confirmLabel="Delete"
        destructive
        loading={deleteThread.isPending}
        onConfirm={handleDelete}
      />

      {/* Workspace rename dialog */}
      <Dialog
        open={Boolean(renameWsTarget)}
        onOpenChange={(open) => !open && setRenameWsTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename workspace</DialogTitle>
          </DialogHeader>
          <Input
            value={renameWsValue}
            onChange={(e) => setRenameWsValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                void handleRenameWorkspace()
              }
            }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameWsTarget(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => void handleRenameWorkspace()}
              disabled={updateWorkspace.isPending || !renameWsValue.trim()}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleteWsTarget)}
        onOpenChange={(open) => !open && setDeleteWsTarget(null)}
        title="Delete workspace"
        description={
          deleteWsTarget
            ? `This will permanently delete "${deleteWsTarget.name || "this workspace"}" and all of its conversations.`
            : undefined
        }
        confirmLabel="Delete"
        destructive
        onConfirm={handleDeleteWorkspace}
      />

      {/* Bulk delete confirmation */}
      <ConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={(open) => !open && setBulkDeleteOpen(false)}
        title={
          selection.kind === "workspace"
            ? "Delete workspaces"
            : "Delete conversations"
        }
        description={
          selection.kind === "workspace"
            ? `This will permanently delete ${selection.count} workspace${
                selection.count > 1 ? "s" : ""
              } and all of their conversations.`
            : `This will permanently delete ${selection.count} conversation${
                selection.count > 1 ? "s" : ""
              }.`
        }
        confirmLabel="Delete"
        destructive
        onConfirm={handleBulkDelete}
      />

      {/* Clone a GitHub repo into the selected workspace's directory */}
      {cloneWsTarget ? (
        <CloneIntoWorkspaceDialog
          open={Boolean(cloneWsTarget)}
          onOpenChange={(open) => !open && setCloneWsTarget(null)}
          workspaceId={cloneWsTarget.id}
          workspaceName={cloneWsTarget.name}
        />
      ) : null}
    </Sidebar>
  )
}

interface WorkspaceTarget {
  id: string
  name: string
}

interface WorkspaceRowProps {
  workspaceId: string
  name: string
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
}

function WorkspaceRow({
  workspaceId,
  name,
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
    } else if (selection.kind === "workspace") {
      e.preventDefault()
      onSelect({ toggle: true, range: false })
    } else {
      onToggle()
    }
  }

  return (
    <SidebarMenuItem className="group/workspace relative">
      <ContextMenu>
        <ContextMenuTrigger asChild>
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
            {isOpen ? (
              <FolderOpen className="size-4" />
            ) : (
              <Folder className="size-4" />
            )}
            <span className="flex-1 truncate">{name}</span>
          </SidebarMenuButton>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={onRenameWorkspace}>
            <Pencil className="size-4" />
            Rename
          </ContextMenuItem>
          <ContextMenuItem onSelect={onCloneWorkspace}>
            <GitBranch className="size-4" />
            Clone repo
          </ContextMenuItem>
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={onDeleteWorkspace}
          >
            <Trash className="size-4" />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

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
  workspaceId: string
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
            onSelect={(mods) => selection.selectThread(thread, mods, threads)}
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
