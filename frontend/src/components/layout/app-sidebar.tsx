import {
  Bot,
  Folder,
  FolderOpen,
  FolderPlus,
  Hammer,
  Hexagon,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Sparkles,
  Trash2,
} from "lucide-react"
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
import { useWorkspaces } from "@/api/workspaces"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { ThemeToggle } from "@/components/theme-toggle"
import { cn } from "@/lib/utils"

interface NavItem {
  to: string
  label: string
  icon: ComponentType<{ className?: string }>
}

const navItems: NavItem[] = [
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/skills", label: "Skills", icon: Sparkles },
  { to: "/tools", label: "Tools", icon: Hammer },
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

  const updateThread = useUpdateThread()
  const deleteThread = useMutation({
    mutationFn: (thread: Thread) => threadsApi.remove(thread.id),
    onSuccess: (_data, thread) => {
      qc.invalidateQueries({ queryKey: threadKeys.byWorkspace(thread.workspace_id) })
    },
  })

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

  const workspaces = workspacesQuery.data ?? []

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-1 group-data-[collapsible=icon]:justify-center">
          <Link
            to="/agents"
            onClick={closeMobile}
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1.5 py-1 group-data-[collapsible=icon]:hidden"
          >
            <Hexagon className="size-6 shrink-0 text-primary" />
            <span className="truncate text-lg font-bold tracking-tight text-foreground">
              Lursor
            </span>
          </Link>
          <SidebarTrigger className="shrink-0" />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Platform</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
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

        <SidebarGroup>
          <div className="flex items-center">
            <SidebarGroupLabel className="flex-1">Workspaces</SidebarGroupLabel>
            <Link
              to="/workspaces"
              onClick={closeMobile}
              title="Manage workspaces"
              className="mr-1 flex size-5 items-center justify-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground group-data-[collapsible=icon]:hidden"
            >
              <FolderPlus className="size-4" />
            </Link>
          </div>
          <SidebarGroupContent>
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
                    onNewChat={() => {
                      setOpenWorkspaces((prev) => new Set(prev).add(ws.id))
                      navigate(`/workspaces/${ws.id}/chat`)
                      closeMobile()
                    }}
                    onNavigate={closeMobile}
                    onRename={(t) => {
                      setRenameTarget(t)
                      setRenameValue(t.title)
                    }}
                    onDelete={setDeleteTarget}
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
            <div className="flex items-center gap-2 group-data-[collapsible=icon]:justify-center">
              <ThemeToggle />
              <span className="text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
                Toggle theme
              </span>
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />

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
    </Sidebar>
  )
}

interface WorkspaceRowProps {
  workspaceId: string
  name: string
  isOpen: boolean
  isActive: boolean
  activeThreadId: string | null
  activeRuns: Set<string>
  onToggle: () => void
  onNewChat: () => void
  onNavigate: () => void
  onRename: (thread: Thread) => void
  onDelete: (thread: Thread) => void
}

function WorkspaceRow({
  workspaceId,
  name,
  isOpen,
  isActive,
  activeThreadId,
  activeRuns,
  onToggle,
  onNewChat,
  onNavigate,
  onRename,
  onDelete,
}: WorkspaceRowProps) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={isActive}
        tooltip={name}
        onClick={onToggle}
      >
        {isOpen ? <FolderOpen className="size-4" /> : <Folder className="size-4" />}
        <span>{name}</span>
      </SidebarMenuButton>
      <SidebarMenuAction showOnHover onClick={onNewChat} title="New conversation">
        <MessageSquare className="size-4" />
      </SidebarMenuAction>

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
    <SidebarMenuSub>
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
    <SidebarMenuSubItem className="group/session relative">
      <SidebarMenuSubButton asChild isActive={isActive}>
        <Link
          to={`/workspaces/${thread.workspace_id}/chat?c=${thread.id}`}
          onClick={onNavigate}
        >
          {running ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <MessageSquare className="size-4" />
          )}
          <span className={cn("flex-1 truncate", running && "text-primary")}>
            {thread.title || "Untitled"}
          </span>
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground group-hover/session:hidden">
            {timeAgo(thread.updated_at)}
          </span>
        </Link>
      </SidebarMenuSubButton>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Conversation options"
            className="absolute right-1 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-sidebar-foreground opacity-0 hover:bg-sidebar-accent focus-visible:opacity-100 group-hover/session:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onRename(thread)}>
            <Pencil className="size-4" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => onDelete(thread)}
          >
            <Trash2 className="size-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuSubItem>
  )
}
