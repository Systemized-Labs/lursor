import { ArrowLeft, MessageSquare, Plus, Trash2 } from "lucide-react"
import { useMemo, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { toast } from "sonner"

import type { Thread } from "@/api/types"
import { useAgents } from "@/api/agents"
import { useDeleteThread, useThreads } from "@/api/threads"
import { useWorkspace } from "@/api/workspaces"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { EmptyState } from "@/components/empty-state"
import { PageHeader } from "@/components/page-header"
import { NewChatDialog } from "./new-chat-dialog"

export function WorkspaceDetailPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const navigate = useNavigate()

  const workspaceQuery = useWorkspace(workspaceId)
  const threadsQuery = useThreads(workspaceId)
  const agentsQuery = useAgents()
  const deleteThread = useDeleteThread(workspaceId)

  const [newChatOpen, setNewChatOpen] = useState(false)
  const [toDelete, setToDelete] = useState<Thread | undefined>(undefined)

  const agentNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const agent of agentsQuery.data ?? []) {
      map.set(agent.id, agent.name)
    }
    return map
  }, [agentsQuery.data])

  const workspace = workspaceQuery.data

  async function confirmDelete() {
    if (!toDelete) return
    try {
      await deleteThread.mutateAsync(toDelete.id)
      toast.success("Thread deleted")
      setToDelete(undefined)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete thread")
    }
  }

  if (workspaceQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading workspace…</p>
  }

  if (workspaceQuery.isError || !workspace) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={() => navigate("/workspaces")}>
          <ArrowLeft className="h-4 w-4" />
          Back to workspaces
        </Button>
        <p className="text-sm text-destructive">
          {workspaceQuery.error instanceof Error
            ? workspaceQuery.error.message
            : "Workspace not found"}
        </p>
      </div>
    )
  }

  const threads = threadsQuery.data ?? []

  return (
    <div className="space-y-6">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 w-fit"
        onClick={() => navigate("/workspaces")}
      >
        <ArrowLeft className="h-4 w-4" />
        Workspaces
      </Button>

      <PageHeader
        title={workspace.name}
        description={workspace.description || "No description"}
        actions={
          <Button
            onClick={() => setNewChatOpen(true)}
            disabled={workspace.agent_ids.length === 0}
          >
            <Plus className="h-4 w-4" />
            New chat
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Workspace details</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              Path
            </span>
            <span className="font-mono text-foreground">{workspace.path}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              Agents
            </span>
            <div className="flex flex-wrap gap-2">
              {workspace.agent_ids.length === 0 ? (
                <span className="text-muted-foreground">None</span>
              ) : (
                workspace.agent_ids.map((id) => (
                  <Badge key={id} variant="secondary">
                    {agentNameById.get(id) ?? id}
                  </Badge>
                ))
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold text-foreground">Threads</h2>
        {threadsQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading threads…</p>
        ) : threads.length === 0 ? (
          <EmptyState
            title="No threads yet"
            description="Start a new chat to create the first thread."
            action={
              <Button
                onClick={() => setNewChatOpen(true)}
                disabled={workspace.agent_ids.length === 0}
              >
                <Plus className="h-4 w-4" />
                New chat
              </Button>
            }
          />
        ) : (
          <div className="grid gap-3">
            {threads.map((thread) => (
              <Card key={thread.id}>
                <CardContent className="flex items-center justify-between gap-3 p-4">
                  <Link
                    to={`/workspaces/${workspace.id}/threads/${thread.id}`}
                    className="flex min-w-0 flex-1 items-center gap-3"
                  >
                    <MessageSquare className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-foreground">
                        {thread.title || "Untitled thread"}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {agentNameById.get(thread.agent_id) ?? thread.agent_id}
                      </span>
                    </span>
                  </Link>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setToDelete(thread)}
                    aria-label="Delete thread"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <NewChatDialog
        open={newChatOpen}
        onOpenChange={setNewChatOpen}
        workspace={workspace}
        agents={agentsQuery.data ?? []}
      />

      <ConfirmDialog
        open={Boolean(toDelete)}
        onOpenChange={(open) => !open && setToDelete(undefined)}
        title="Delete thread"
        description={
          toDelete
            ? `This will permanently delete "${toDelete.title || "this thread"}".`
            : undefined
        }
        confirmLabel="Delete"
        destructive
        loading={deleteThread.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  )
}
