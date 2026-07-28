import { Pencil, Plus, Trash } from "@phosphor-icons/react"
import { useState } from "react"
import { toast } from "sonner"

import type { Tool } from "@/api/types"
import { useDeleteTool, useTools } from "@/api/tools"
import { Badge } from "@/components/ui/badge"
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
import { ToolFormDialog } from "./tool-form-dialog"

const DESCRIPTION = "Capabilities agents can call: builtin, MCP, or HTTP."

export function ToolsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { data: tools, isLoading, isError, error } = useTools()
  const deleteTool = useDeleteTool()

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Tool | undefined>(undefined)
  const [toDelete, setToDelete] = useState<Tool | undefined>(undefined)

  function openCreate() {
    setEditing(undefined)
    setFormOpen(true)
  }

  async function confirmDelete() {
    if (!toDelete) return
    try {
      await deleteTool.mutateAsync(toDelete.id)
      toast.success("Tool deleted")
      setToDelete(undefined)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete tool")
    }
  }

  const action = (
    <Button onClick={openCreate}>
      <Plus className="h-4 w-4" />
      New tool
    </Button>
  )

  return (
    <div className="space-y-6">
      {embedded ? (
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">{DESCRIPTION}</p>
          {action}
        </div>
      ) : (
        <PageHeader title="Tools" description={DESCRIPTION} actions={action} />
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading tools…</p>
      ) : isError ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load tools"}
        </p>
      ) : !tools || tools.length === 0 ? (
        <EmptyState
          title="No tools yet"
          description="Register a tool to give your agents new capabilities."
          action={
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" />
              New tool
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {tools.map((tool) => (
            <Card key={tool.id} className="flex flex-col">
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="truncate">{tool.name}</CardTitle>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        setEditing(tool)
                        setFormOpen(true)
                      }}
                      aria-label="Edit tool"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setToDelete(tool)}
                      aria-label="Delete tool"
                    >
                      <Trash className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <CardDescription className="line-clamp-2">
                  {tool.description || "No description"}
                </CardDescription>
              </CardHeader>
              <CardContent className="mt-auto">
                <Badge variant="secondary">{tool.kind}</Badge>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ToolFormDialog open={formOpen} onOpenChange={setFormOpen} tool={editing} />

      <ConfirmDialog
        open={Boolean(toDelete)}
        onOpenChange={(open) => !open && setToDelete(undefined)}
        title="Delete tool"
        description={
          toDelete
            ? `This will permanently delete "${toDelete.name}".`
            : undefined
        }
        confirmLabel="Delete"
        destructive
        loading={deleteTool.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  )
}
