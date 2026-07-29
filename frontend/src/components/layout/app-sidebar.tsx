import {
  ChartBar,
  Clock,
  Cpu,
  FolderPlus,
  Gear,
  GitBranch,
  MagnifyingGlass,
  NotePencil,
  Palette,
  Plus,
  SlidersHorizontal,
  Trash,
  X,
} from "@phosphor-icons/react"
import {
  type ComponentType,
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

import type { Thread, Workspace, WorkspaceFolder } from "@/api/types"
import {
  threadKeys,
  threadsApi,
  useActiveRuns,
  useUpdateThread,
} from "@/api/threads"
import {
  useDeleteWorkspace,
  useUpdateWorkspace,
  useWorkspaces,
  workspaceKeys,
  workspacesApi,
} from "@/api/workspaces"
import {
  useCreateWorkspaceFolder,
  useDeleteWorkspaceFolder,
  useRenameWorkspaceFolder,
  useWorkspaceFolders,
} from "@/api/workspace-folders"
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
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useOptimisticRuns } from "@/hooks/use-optimistic-runs"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { ThemePicker } from "@/components/ui/theme-picker"
import { WorkspaceFormDialog } from "@/pages/workspaces/workspace-form-dialog"
import { CloneIntoWorkspaceDialog } from "@/pages/workspaces/clone-into-workspace-dialog"
import { useCommandPalette } from "@/components/command-palette/command-palette"
import { useSidebarSelection } from "@/components/layout/use-sidebar-selection"
import { WorkspaceRow } from "@/components/layout/workspace-row"
import { WorkspaceTree } from "@/components/layout/workspace-tree"
import { cn } from "@/lib/utils"
import { isMacElectron } from "@/lib/platform"

interface NavItem {
  to: string
  label: string
  icon: ComponentType<{ className?: string }>
}

const navItems: NavItem[] = [
  { to: "/analytics", label: "Usage", icon: ChartBar },
  { to: "/schedules", label: "Schedules", icon: Clock },
  { to: "/laios", label: "LAIOS", icon: Cpu },
  { to: "/customization", label: "Customization", icon: SlidersHorizontal },
]

/**
 * The studio's nav label is fixed, like every other entry in Platform — it's a
 * destination, not a folder you named. Reading it off the workspace record would
 * let the row retitle itself (or, before the list loads, not exist), which is
 * not how a nav item behaves. Mirrors `SKILLS_WORKSPACE_NAME` on the backend.
 */
const SKILL_STUDIO_LABEL = "Skill Studio"

/**
 * Cursor-style left navigation: the primary destinations up top, then the
 * workspaces — grouped into folders, and rendered as expandable rows whose
 * conversations nest beneath them. Selecting a conversation drives the chat
 * surface via `?c=<threadId>`.
 */
export function AppSidebar() {
  const { pathname } = useLocation()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { isMobile, setOpenMobile } = useSidebar()
  const { open: openCommandPalette } = useCommandPalette()
  const qc = useQueryClient()

  const workspacesQuery = useWorkspaces()
  const foldersQuery = useWorkspaceFolders()
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

  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState("")
  const [renameFolderTarget, setRenameFolderTarget] =
    useState<WorkspaceFolder | null>(null)
  const [renameFolderValue, setRenameFolderValue] = useState("")
  const [deleteFolderTarget, setDeleteFolderTarget] =
    useState<WorkspaceFolder | null>(null)

  const updateThread = useUpdateThread()
  const deleteThread = useMutation({
    mutationFn: (thread: Thread) => threadsApi.remove(thread.id),
    onSuccess: (_data, thread) => {
      qc.invalidateQueries({ queryKey: threadKeys.byWorkspace(thread.workspace_id) })
    },
  })

  const updateWorkspace = useUpdateWorkspace()
  const deleteWorkspace = useDeleteWorkspace()

  const createFolder = useCreateWorkspaceFolder()
  const renameFolder = useRenameWorkspaceFolder()
  const deleteFolder = useDeleteWorkspaceFolder()

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

  const openWorkspace = (id: string) =>
    setOpenWorkspaces((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))

  const newConversation = (workspaceId: string) => {
    openWorkspace(workspaceId)
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

  async function handleCreateFolder() {
    const name = newFolderName.trim()
    if (!name) return
    try {
      await createFolder.mutateAsync(name)
      setNewFolderOpen(false)
      setNewFolderName("")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create folder")
    }
  }

  async function handleRenameFolder() {
    if (!renameFolderTarget) return
    const name = renameFolderValue.trim()
    if (!name) return
    try {
      await renameFolder.mutateAsync({ id: renameFolderTarget.id, name })
      setRenameFolderTarget(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to rename")
    }
  }

  function handleDeleteFolder() {
    if (!deleteFolderTarget) return
    const folder = deleteFolderTarget
    setDeleteFolderTarget(null)
    deleteFolder.mutate(folder.id, {
      onSuccess: () => toast.success(`Folder "${folder.name}" deleted`),
      onError: (err) =>
        toast.error(err instanceof Error ? err.message : "Failed to delete"),
    })
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
      const ids = new Set(threads.map((t) => t.id))
      const affected = [...new Set(threads.map((t) => t.workspace_id))]
      const previous = affected.map((wsId) => ({
        wsId,
        data: qc.getQueryData<Thread[]>(threadKeys.byWorkspace(wsId)),
      }))
      for (const wsId of affected) {
        qc.setQueryData<Thread[]>(threadKeys.byWorkspace(wsId), (old) =>
          (old ?? []).filter((t) => !ids.has(t.id))
        )
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
          for (const { wsId, data } of previous) {
            if (data) qc.setQueryData(threadKeys.byWorkspace(wsId), data)
          }
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

  // Skill Studio is a fixed destination, not one of your projects: it lives in
  // Platform above the Workspaces group. Still rendered as a workspace row
  // there, so conversations about skills nest under it and stay resumable.
  const studioId = workspacesQuery.data?.find((ws) => ws.is_system)?.id
  const workspaces = useMemo(
    () => (workspacesQuery.data ?? []).filter((ws) => !ws.is_system),
    [workspacesQuery.data]
  )
  const folders = foldersQuery.data ?? []

  // Entering the studio expands it, however you got there — its own row, the
  // manager's "Author with agent", a skill deep link, the palette. Otherwise you
  // land inside a workspace whose sidebar row still looks shut. Only on the way
  // *in*: collapsing it by hand while you're already there has to stick, which a
  // plain `activeWorkspaceId === id` effect would undo on the next render.
  const prevActiveWorkspace = useRef(activeWorkspaceId)
  useEffect(() => {
    const entered = prevActiveWorkspace.current !== activeWorkspaceId
    prevActiveWorkspace.current = activeWorkspaceId
    if (entered && studioId && activeWorkspaceId === studioId) {
      openWorkspace(studioId)
    }
    // `openWorkspace` is a stable state setter wrapper; re-running on identity
    // would fire this on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceId, studioId])

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
          {/* Fixed-height group, except that Skill Studio's conversations hang
              off it — cap the growth and scroll, so a busy studio can never
              push the workspace list out of the viewport. */}
          <SidebarGroupContent className="scrollbar-hover max-h-[55vh] overflow-y-auto group-data-[collapsible=icon]:overflow-hidden">
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
              {/* A destination like the rest of this group, but a real
                  workspace underneath — so it keeps the folder's expandable
                  conversation list. Always rendered, label and all: the backing
                  workspace only decides where the row *goes*, never whether it
                  shows up, so the nav doesn't reshuffle as the list loads. Not
                  selectable either: it can't be bulk-deleted (the API refuses),
                  so it stays out of range selection too. */}
              <WorkspaceRow
                workspaceId={studioId}
                name={SKILL_STUDIO_LABEL}
                isSystem
                isOpen={studioId ? openWorkspaces.has(studioId) : false}
                isActive={studioId ? activeWorkspaceId === studioId : false}
                isSelected={false}
                selection={selection}
                onSelect={() => {}}
                activeThreadId={activeThreadId}
                activeRuns={activeRuns}
                // A nav item should navigate. Coming from outside, clicking
                // only travels — the effect above does the expanding, so an
                // already-open studio can't get collapsed by the click that
                // enters it. Once inside, it's a plain folder toggle;
                // navigating again would drop the `?c=` and reset the open
                // conversation.
                onToggle={() => {
                  if (!studioId) return
                  if (activeWorkspaceId === studioId) {
                    toggleWorkspace(studioId)
                    return
                  }
                  navigate(`/workspaces/${studioId}/chat`)
                  closeMobile()
                }}
                onNewConversation={() => {
                  if (studioId) newConversation(studioId)
                }}
                onNavigate={closeMobile}
                onRename={(t) => {
                  setRenameTarget(t)
                  setRenameValue(t.title)
                }}
                onDelete={setDeleteTarget}
                // Fixed label, so there's nothing to rename — and the row's
                // context menu is suppressed for the studio anyway.
                onRenameWorkspace={() => {}}
                onDeleteWorkspace={() => {}}
                onCloneWorkspace={() => {}}
              />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="flex min-h-0 flex-1 flex-col">
          <div className="group/workspaces flex items-center">
            <SidebarGroupLabel className="flex-1">Workspaces</SidebarGroupLabel>
            <button
              type="button"
              onClick={() => {
                setNewFolderName("")
                setNewFolderOpen(true)
              }}
              title="New folder"
              aria-label="New folder"
              className="flex size-5 items-center justify-center rounded-md text-sidebar-foreground/70 opacity-0 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:opacity-100 group-hover/workspaces:opacity-100 group-data-[collapsible=icon]:hidden"
            >
              <FolderPlus className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => setWorkspaceFormOpen(true)}
              title="New workspace"
              aria-label="New workspace"
              className="mx-1 flex size-5 items-center justify-center rounded-md text-sidebar-foreground/70 opacity-0 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:opacity-100 group-hover/workspaces:opacity-100 group-data-[collapsible=icon]:hidden"
            >
              <Plus className="size-4" />
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
              <WorkspaceTree
                workspaces={workspaces}
                folders={folders}
                isLoading={workspacesQuery.isLoading || foldersQuery.isLoading}
                activeWorkspaceId={activeWorkspaceId}
                activeThreadId={activeThreadId}
                activeRuns={activeRuns}
                openWorkspaces={openWorkspaces}
                onToggleWorkspace={toggleWorkspace}
                onNewConversation={newConversation}
                selection={selection}
                onNavigate={closeMobile}
                onRenameThread={(t) => {
                  setRenameTarget(t)
                  setRenameValue(t.title)
                }}
                onDeleteThread={setDeleteTarget}
                onRenameWorkspace={(ws) => {
                  setRenameWsTarget({ id: ws.id, name: ws.name })
                  setRenameWsValue(ws.name)
                }}
                onDeleteWorkspace={(ws) =>
                  setDeleteWsTarget({ id: ws.id, name: ws.name })
                }
                onCloneWorkspace={(ws) =>
                  setCloneWsTarget({ id: ws.id, name: ws.name })
                }
                onRenameFolder={(folder) => {
                  setRenameFolderTarget(folder)
                  setRenameFolderValue(folder.name)
                }}
                onDeleteFolder={setDeleteFolderTarget}
              />
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

      {/* New folder dialog */}
      <Dialog
        open={newFolderOpen}
        onOpenChange={(open) => !open && setNewFolderOpen(false)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
          </DialogHeader>
          <Input
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            placeholder="Clients"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                void handleCreateFolder()
              }
            }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewFolderOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void handleCreateFolder()}
              disabled={createFolder.isPending || !newFolderName.trim()}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Folder rename dialog */}
      <Dialog
        open={Boolean(renameFolderTarget)}
        onOpenChange={(open) => !open && setRenameFolderTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename folder</DialogTitle>
          </DialogHeader>
          <Input
            value={renameFolderValue}
            onChange={(e) => setRenameFolderValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                void handleRenameFolder()
              }
            }}
            autoFocus
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRenameFolderTarget(null)}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleRenameFolder()}
              disabled={renameFolder.isPending || !renameFolderValue.trim()}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(deleteFolderTarget)}
        onOpenChange={(open) => !open && setDeleteFolderTarget(null)}
        title="Delete folder"
        description={
          deleteFolderTarget
            ? `"${deleteFolderTarget.name}" is only a group — the workspaces inside it move back out to the top level and keep all of their conversations.`
            : undefined
        }
        confirmLabel="Delete folder"
        destructive
        onConfirm={handleDeleteFolder}
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
