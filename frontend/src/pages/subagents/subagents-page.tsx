import { Pencil, Plus, Trash } from "@phosphor-icons/react"
import { useState } from "react"
import { toast } from "sonner"

import type { BuiltinSubagent, Subagent } from "@/api/types"
import {
  useDeleteSubagent,
  useSubagentDefaults,
  useSubagents,
  useUpdateSubagent,
  useUpdateSubagentDefaults,
} from "@/api/subagents"
import { useModels } from "@/api/models"
import { formatModelName } from "@/lib/model-label"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { EmptyState } from "@/components/empty-state"
import { PageHeader } from "@/components/page-header"
import {
  BuiltinCard,
  BuiltinOverrideDialog,
  nextDisabledBuiltins,
} from "./subagent-defaults-panel"
import { SubagentFormDialog } from "./subagent-form-dialog"

const DESCRIPTION =
  "Specialists your agents can delegate to. They apply to every agent that has subagents enabled. Toggle any off to keep it without offering it to agents."

export function SubagentsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const subagents = useSubagents()
  const defaults = useSubagentDefaults()
  const deleteSubagent = useDeleteSubagent()
  const updateSubagent = useUpdateSubagent()
  const updateDefaults = useUpdateSubagentDefaults()

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Subagent | undefined>(undefined)
  const [editingBuiltin, setEditingBuiltin] = useState<BuiltinSubagent | undefined>(
    undefined
  )
  const [toDelete, setToDelete] = useState<Subagent | undefined>(undefined)

  function openCreate() {
    setEditing(undefined)
    setFormOpen(true)
  }

  async function toggleUser(subagent: Subagent, enabled: boolean) {
    try {
      await updateSubagent.mutateAsync({ id: subagent.id, input: { enabled } })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update subagent")
    }
  }

  async function toggleBuiltin(builtin: BuiltinSubagent, enabled: boolean) {
    try {
      await updateDefaults.mutateAsync({
        disabled_builtins: nextDisabledBuiltins(
          defaults.data?.builtins ?? [],
          builtin.name,
          enabled
        ),
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update")
    }
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

  const isLoading = subagents.isLoading || defaults.isLoading
  const isError = subagents.isError || defaults.isError
  const error = subagents.error ?? defaults.error
  const userSubagents = subagents.data ?? []
  const builtins = defaults.data?.builtins ?? []
  const isEmpty = userSubagents.length === 0 && builtins.length === 0

  const grid =
    isLoading ? (
      <p className="text-sm text-muted-foreground">Loading subagents…</p>
    ) : isError ? (
      <p className="text-sm text-destructive">
        {error instanceof Error ? error.message : "Failed to load subagents"}
      </p>
    ) : isEmpty ? (
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
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {userSubagents.map((subagent) => (
          <UserSubagentCard
            key={subagent.id}
            subagent={subagent}
            onToggle={(enabled) => toggleUser(subagent, enabled)}
            onEdit={() => {
              setEditing(subagent)
              setFormOpen(true)
            }}
            onDelete={() => setToDelete(subagent)}
          />
        ))}
        {builtins.map((builtin) => (
          <BuiltinCard
            key={builtin.name}
            builtin={builtin}
            onToggle={(enabled) => toggleBuiltin(builtin, enabled)}
            onEdit={() => setEditingBuiltin(builtin)}
          />
        ))}
      </div>
    )

  return (
    <div className="space-y-6">
      {embedded ? (
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">{DESCRIPTION}</p>
          <Button onClick={openCreate} className="shrink-0">
            <Plus className="h-4 w-4" />
            New subagent
          </Button>
        </div>
      ) : (
        <PageHeader
          title="Subagents"
          description={DESCRIPTION}
          actions={
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" />
              New subagent
            </Button>
          }
        />
      )}

      {grid}

      <SubagentFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        subagent={editing}
      />

      <BuiltinOverrideDialog
        builtin={editingBuiltin}
        onOpenChange={(open) => !open && setEditingBuiltin(undefined)}
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

function UserSubagentCard({
  subagent,
  onToggle,
  onEdit,
  onDelete,
}: {
  subagent: Subagent
  onToggle: (enabled: boolean) => void
  onEdit: () => void
  onDelete: () => void
}) {
  const { data: modelGroups } = useModels()
  return (
    <Card className={cn("flex flex-col", !subagent.enabled && "opacity-60")}>
      <CardHeader className="gap-3">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="min-w-0 flex-1 break-words">
            {subagent.name}
          </CardTitle>
          <Switch
            checked={subagent.enabled}
            onCheckedChange={onToggle}
            className="mt-0.5 shrink-0"
            aria-label={`Enable ${subagent.name}`}
          />
        </div>
        <CardDescription className="line-clamp-2">
          {subagent.description || "No description"}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {subagent.model && (
          <p
            className="truncate text-xs text-muted-foreground"
            title={subagent.model}
          >
            <span className="text-foreground/70">Model:</span>{" "}
            {formatModelName(subagent.model, modelGroups)}
          </p>
        )}
        <p className="line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">
          {subagent.instructions || "No instructions."}
        </p>
      </CardContent>
      <CardFooter className="mt-auto gap-1">
        <Button variant="outline" size="sm" onClick={onEdit}>
          <Pencil className="h-4 w-4" />
          Edit
        </Button>
        <Button variant="ghost" size="sm" onClick={onDelete}>
          <Trash className="h-4 w-4" />
          Delete
        </Button>
      </CardFooter>
    </Card>
  )
}
