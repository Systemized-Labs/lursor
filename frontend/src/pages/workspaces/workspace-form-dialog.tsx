import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import type { Workspace, WorkspaceInput } from "@/api/types"
import { useAgents } from "@/api/agents"
import {
  useCreateWorkspace,
  useUpdateWorkspace,
} from "@/api/workspaces"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { MultiSelect } from "@/components/multi-select"

interface FormState {
  name: string
  description: string
  agent_ids: string[]
}

const EMPTY: FormState = { name: "", description: "", agent_ids: [] }

interface WorkspaceFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspace?: Workspace
}

export function WorkspaceFormDialog({
  open,
  onOpenChange,
  workspace,
}: WorkspaceFormDialogProps) {
  const [form, setForm] = useState<FormState>(EMPTY)
  const agentsQuery = useAgents()
  const createWorkspace = useCreateWorkspace()
  const updateWorkspace = useUpdateWorkspace()
  const isEdit = Boolean(workspace)
  const isSaving = createWorkspace.isPending || updateWorkspace.isPending

  useEffect(() => {
    if (open) {
      setForm(
        workspace
          ? {
              name: workspace.name,
              description: workspace.description,
              agent_ids: workspace.agent_ids,
            }
          : EMPTY
      )
    }
  }, [open, workspace])

  const agentOptions = useMemo(
    () =>
      (agentsQuery.data ?? []).map((a) => ({
        value: a.id,
        label: a.name,
        description: a.description,
      })),
    [agentsQuery.data]
  )

  async function handleSubmit() {
    if (!form.name.trim()) {
      toast.error("Name is required")
      return
    }
    const input: WorkspaceInput = {
      name: form.name.trim(),
      description: form.description.trim(),
      agent_ids: form.agent_ids,
    }
    try {
      if (workspace) {
        await updateWorkspace.mutateAsync({ id: workspace.id, input })
        toast.success("Workspace updated")
      } else {
        await createWorkspace.mutateAsync(input)
        toast.success("Workspace created")
      }
      onOpenChange(false)
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to save workspace"
      )
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit workspace" : "New workspace"}
          </DialogTitle>
          <DialogDescription>
            A workspace groups agents and hosts chat threads.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="workspace-name">Name</Label>
            <Input
              id="workspace-name"
              value={form.name}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, name: e.target.value }))
              }
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="workspace-description">Description</Label>
            <Input
              id="workspace-description"
              value={form.description}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, description: e.target.value }))
              }
            />
          </div>
          <div className="grid gap-2">
            <Label>Agents</Label>
            <MultiSelect
              options={agentOptions}
              selected={form.agent_ids}
              onChange={(ids) =>
                setForm((prev) => ({ ...prev, agent_ids: ids }))
              }
              emptyText="No agents created yet."
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isSaving}>
            {isEdit ? "Save changes" : "Create workspace"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
