import { Pencil, Plus, Trash2 } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import type { Subagent } from "@/api/types"
import { useDeleteSubagent, useSubagents } from "@/api/subagents"
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
import { SubagentFormDialog } from "./subagent-form-dialog"

const DESCRIPTION =
  "Specialists your agents can delegate to. They apply to every agent that has subagents enabled."

export function SubagentsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { data: subagents, isLoading, isError, error } = useSubagents()
  const deleteSubagent = useDeleteSubagent()

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Subagent | undefined>(undefined)
  const [toDelete, setToDelete] = useState<Subagent | undefined>(undefined)

  function openCreate() {
    setEditing(undefined)
    setFormOpen(true)
  }

  async function confirmDelete() {
    if (!toDelete) return
    try {
      await deleteSubagent.mutateAsync(toDelete.id)
      toast.success("Subagent deleted")
      setToDelete(undefined)
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to delete subagent"
      )
    }
  }

  const action = (
    <Button onClick={openCreate}>
      <Plus className="h-4 w-4" />
      New subagent
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
        <PageHeader title="Subagents" description={DESCRIPTION} actions={action} />
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading subagents…</p>
      ) : isError ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load subagents"}
        </p>
      ) : !subagents || subagents.length === 0 ? (
        <EmptyState
          title="No subagents yet"
          description="Create a subagent to give your agents a specialist to delegate to."
          action={
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" />
              New subagent
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {subagents.map((subagent) => (
            <Card key={subagent.id} className="flex flex-col">
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="truncate">{subagent.name}</CardTitle>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        setEditing(subagent)
                        setFormOpen(true)
                      }}
                      aria-label="Edit subagent"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setToDelete(subagent)}
                      aria-label="Delete subagent"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <CardDescription className="line-clamp-2">
                  {subagent.description || "No description"}
                </CardDescription>
              </CardHeader>
              <CardContent className="mt-auto space-y-2">
                {subagent.model && (
                  <p className="truncate text-xs text-muted-foreground">
                    Model: {subagent.model}
                  </p>
                )}
                <p className="line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">
                  {subagent.instructions || "No instructions."}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <SubagentFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        subagent={editing}
      />

      <ConfirmDialog
        open={Boolean(toDelete)}
        onOpenChange={(open) => !open && setToDelete(undefined)}
        title="Delete subagent"
        description={
          toDelete
            ? `This will permanently delete "${toDelete.name}".`
            : undefined
        }
        confirmLabel="Delete"
        destructive
        loading={deleteSubagent.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  )
}
