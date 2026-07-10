import { FolderOpen, Pencil, Plus, Trash2 } from "lucide-react"
import { useState } from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"

import type { Workspace } from "@/api/types"
import { useDeleteWorkspace, useWorkspaces } from "@/api/workspaces"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { EmptyState } from "@/components/empty-state"
import { PageHeader } from "@/components/page-header"
import { WorkspaceFormDialog } from "./workspace-form-dialog"

export function WorkspacesPage() {
  const { data: workspaces, isLoading, isError, error } = useWorkspaces()
  const deleteWorkspace = useDeleteWorkspace()

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Workspace | undefined>(undefined)
  const [toDelete, setToDelete] = useState<Workspace | undefined>(undefined)

  function openCreate() {
    setEditing(undefined)
    setFormOpen(true)
  }

  async function confirmDelete() {
    if (!toDelete) return
    try {
      await deleteWorkspace.mutateAsync(toDelete.id)
      toast.success("Workspace deleted")
      setToDelete(undefined)
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to delete workspace"
      )
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Workspaces"
        description="Group agents and chat with them inside a workspace."
        actions={
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" />
            New workspace
          </Button>
        }
      />

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading workspaces…</p>
      ) : isError ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load workspaces"}
        </p>
      ) : !workspaces || workspaces.length === 0 ? (
        <EmptyState
          title="No workspaces yet"
          description="Create a workspace to start chatting with your agents."
          action={
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" />
              New workspace
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {workspaces.map((workspace) => (
            <Card key={workspace.id} className="flex flex-col">
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="truncate">{workspace.name}</CardTitle>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        setEditing(workspace)
                        setFormOpen(true)
                      }}
                      aria-label="Edit workspace"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setToDelete(workspace)}
                      aria-label="Delete workspace"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <CardDescription className="line-clamp-2">
                  {workspace.description || "No description"}
                </CardDescription>
              </CardHeader>
              <CardContent className="mt-auto space-y-3">
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {workspace.path}
                </p>
                <div className="flex items-center justify-end gap-2">
                  <Button asChild variant="secondary" size="sm">
                    <Link to={`/workspaces/${workspace.id}`}>
                      <FolderOpen className="h-4 w-4" />
                      Open
                    </Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <WorkspaceFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        workspace={editing}
      />

      <ConfirmDialog
        open={Boolean(toDelete)}
        onOpenChange={(open) => !open && setToDelete(undefined)}
        title="Delete workspace"
        description={
          toDelete
            ? `This will permanently delete "${toDelete.name}" and its threads.`
            : undefined
        }
        confirmLabel="Delete"
        destructive
        loading={deleteWorkspace.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  )
}
