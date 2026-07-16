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
import { type ComponentType, useEffect, useMemo, useState } from "react"
import {
  Link,
  matchPath,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import type { Thread } from "@/api/types"
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
} from "@/api/workspaces"
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
  SidebarTrigger,
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
import { ConfirmDialog } from "@/components/confirm-dialog"
import { ThemePicker } from "@/components/ui/theme-picker"
import { WorkspaceFormDialog } from "@/pages/workspaces/workspace-form-dialog"
import { CloneIntoWorkspaceDialog } from "@/pages/workspaces/clone-into-workspace-dialog"
import { useCommandPalette } from "@/components/command-palette/command-palette"
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
  const activeRunsQuery = useActiveRuns()
  const activeRuns = useMemo(
    () => new Set(activeRunsQuery.data ?? []),
    [activeRunsQuery.data]
  )

  const chatMatch =
    matchPath("/workspaces/:workspaceId/chat", pathname) ??
    matchPath("/workspaces/:workspaceId", pathname)
  const activeWorkspaceId = chatMatch?.params.workspaceId
  const activeThreadId = searchParams.get("c")

  const [openWorkspaces, setOpenWorkspaces] = useState<Set<string>>(new Set())
  // Auto-expand the workspace you're currently in.
  useEffect(() => {
    if (activeWorkspaceId) {
      setOpenWorkspaces((prev) =>
        prev.has(activeWorkspaceId) ? prev : new Set(prev).add(activeWorkspaceId)
      )
    }
  }, [activeWorkspaceId])

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

  async function handleDeleteWorkspace() {
    if (!deleteWsTarget) return
    const ws = deleteWsTarget
    try {
      await deleteWorkspace.mutateAsync(ws.id)
      setDeleteWsTarget(null)
      // If the open workspace was deleted, leave the chat surface.
      if (activeWorkspaceId === ws.id) {
        navigate("/customization")
      }
      toast.success("Workspace deleted")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete")
    }
  }

  const workspaces = workspacesQuery.data ?? []

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader
        className={cn(
          // On macOS Electron, drop the header below the overlaid traffic
          // lights and let the empty strip drag the window.
          isMacElectron && "pt-8 [-webkit-app-region:drag]"
        )}
      >
        <div className="flex items-center justify-between gap-1">
          <Link
            to="/"
            onClick={closeMobile}
            className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0 [-webkit-app-region:no-drag]"
          >
            <img
              src="/lursor_icon.png"
              alt="Lursor"
              className="size-11 shrink-0 rounded-md object-contain"
            />
            <span className="truncate text-lg font-bold tracking-tight text-foreground group-data-[collapsible=icon]:hidden">
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
            <SidebarMenuButton
              isActive={isNavActive("/settings")}
              tooltip="Settings"
              asChild
            >
              <Link to="/settings" onClick={closeMobile}>
                <Gear className="size-4" />
                <span>Settings</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <div className="flex items-center justify-between group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:gap-2">
              <ThemePicker
                trigger={(open) => (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Choose theme"
                    onClick={open}
                  >
                    <Palette className="h-5 w-5" />
                    <span className="sr-only">Choose theme</span>
                  </Button>
                )}
              />
              {/* The collapse-to-rail toggle only makes sense for the desktop
                  docked sidebar; the mobile drawer closes via the header X. */}
              {!isMobile && <SidebarTrigger className="shrink-0" />}
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
        loading={deleteWorkspace.isPending}
        onConfirm={handleDeleteWorkspace}
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
  return (
    <SidebarMenuItem className="group/workspace relative">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <SidebarMenuButton isActive={isActive} tooltip={name} onClick={onToggle}>
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
            Clone GitHub repo…
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

      {isOpen ? (
        <WorkspaceThreads
          workspaceId={workspaceId}
          activeThreadId={activeThreadId}
          activeRuns={activeRuns}
          onNavigate={onNavigate}
          onRename={onRename}
          onDelete={onDelete}
        />
      ) : null}
    </SidebarMenuItem>
  )
}

interface WorkspaceThreadsProps {
  workspaceId: string
  activeThreadId: string | null
  activeRuns: Set<string>
  onNavigate: () => void
  onRename: (thread: Thread) => void
  onDelete: (thread: Thread) => void
}

/** Nested conversation list; only mounts (and fetches) while its folder is open. */
function WorkspaceThreads({
  workspaceId,
  activeThreadId,
  activeRuns,
  onNavigate,
  onRename,
  onDelete,
}: WorkspaceThreadsProps) {
  const threadsQuery = useThreads(workspaceId)
  const threads = threadsQuery.data ?? []

  return (
    <SidebarMenuSub className="mx-2 px-1.5">
      {threadsQuery.isLoading ? (
        <li className="px-2 py-1 text-[11px] text-muted-foreground">Loading…</li>
      ) : threads.length === 0 ? (
        <li className="px-2 py-1 text-[11px] text-muted-foreground">
          No conversations
        </li>
      ) : (
        threads.map((thread) => (
          <SessionRow
            key={thread.id}
            thread={thread}
            isActive={thread.id === activeThreadId}
            running={activeRuns.has(thread.id)}
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
  onNavigate: () => void
  onRename: (thread: Thread) => void
  onDelete: (thread: Thread) => void
}

function SessionRow({
  thread,
  isActive,
  running,
  onNavigate,
  onRename,
  onDelete,
}: SessionRowProps) {
  return (
    <SidebarMenuSubItem className="group/session">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <SidebarMenuSubButton asChild isActive={isActive}>
            <Link
              to={`/workspaces/${thread.workspace_id}/chat?c=${thread.id}`}
              onClick={onNavigate}
            >
              {running ? (
                <DotGridLoader
                  size="xs"
                  className="shrink-0 text-primary"
                  label="Working"
                />
              ) : (
                <ChatCentered className="size-4" />
              )}
              <span className={cn("flex-1 truncate", running && "text-primary")}>
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
