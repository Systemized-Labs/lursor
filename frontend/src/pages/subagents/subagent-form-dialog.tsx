import { FileText } from "@phosphor-icons/react"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import type { Subagent, SubagentInput } from "@/api/types"
import { useCreateSubagent, useUpdateSubagent } from "@/api/subagents"
import { usePromptTemplates } from "@/api/prompt-templates"
import { ConfirmDialog } from "@/components/confirm-dialog"
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
import { ModelPicker } from "@/components/model-picker"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"

interface FormState {
  name: string
  description: string
  instructions: string
  model: string
}

const EMPTY: FormState = { name: "", description: "", instructions: "", model: "" }

interface SubagentFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  subagent?: Subagent
}

export function SubagentFormDialog({
  open,
  onOpenChange,
  subagent,
}: SubagentFormDialogProps) {
  const [form, setForm] = useState<FormState>(EMPTY)
  // A pending destructive replace guarded by a confirm dialog when the
  // instructions field already has content.
  const [pendingInstructions, setPendingInstructions] = useState<string | null>(
    null
  )
  const createSubagent = useCreateSubagent()
  const updateSubagent = useUpdateSubagent()
  const templatesQuery = usePromptTemplates()
  const isEdit = Boolean(subagent)
  const isSaving = createSubagent.isPending || updateSubagent.isPending

  const templateGroups = useMemo(() => {
    const byCategory = new Map<string, { id: string; name: string }[]>()
    for (const t of templatesQuery.data ?? []) {
      const list = byCategory.get(t.category) ?? []
      list.push({ id: t.id, name: t.name })
      byCategory.set(t.category, list)
    }
    return [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [templatesQuery.data])

  useEffect(() => {
    if (open) {
      setForm(
        subagent
          ? {
              name: subagent.name,
              description: subagent.description,
              instructions: subagent.instructions,
              model: subagent.model ?? "",
            }
          : EMPTY
      )
      setPendingInstructions(null)
    }
  }, [open, subagent])

  /** Set instructions, confirming first when there is content to overwrite. */
  function applyInstructions(next: string) {
    if (form.instructions.trim()) {
      setPendingInstructions(next)
    } else {
      setForm((prev) => ({ ...prev, instructions: next }))
    }
  }

  function handlePickTemplate(templateId: string) {
    const template = (templatesQuery.data ?? []).find(
      (t) => t.id === templateId
    )
    if (template) applyInstructions(template.content)
  }

  async function handleSubmit() {
    if (!form.name.trim()) {
      toast.error("Name is required")
      return
    }
    const input: SubagentInput = {
      name: form.name.trim(),
      description: form.description.trim(),
      instructions: form.instructions,
      model: form.model.trim() ? form.model.trim() : null,
    }
    try {
      if (subagent) {
        await updateSubagent.mutateAsync({ id: subagent.id, input })
        toast.success("Subagent updated")
      } else {
        await createSubagent.mutateAsync(input)
        toast.success("Subagent created")
      }
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save subagent")
    }
  }

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit subagent" : "New subagent"}</DialogTitle>
          <DialogDescription>
            Subagents are specialists your agents can delegate tasks to. They
            apply to every agent that has subagents enabled.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="subagent-name">Name</Label>
            <Input
              id="subagent-name"
              value={form.name}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, name: e.target.value }))
              }
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="subagent-description">Description</Label>
            <Input
              id="subagent-description"
              value={form.description}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, description: e.target.value }))
              }
            />
            <p className="text-xs text-muted-foreground">
              Shown to the parent agent when it chooses which specialist to
              delegate to.
            </p>
          </div>
          <div className="grid min-w-0 gap-2">
            <Label htmlFor="subagent-model">Model</Label>
            <ModelPicker
              value={form.model}
              onChange={(value) =>
                setForm((prev) => ({ ...prev, model: value }))
              }
            />
            <p className="text-xs text-muted-foreground">
              Optional. Leave unset to inherit the parent agent's model.
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="subagent-instructions">Instructions</Label>
            <Textarea
              id="subagent-instructions"
              value={form.instructions}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, instructions: e.target.value }))
              }
              className="min-h-[200px] font-mono text-xs"
              spellCheck={false}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Select value="" onValueChange={handlePickTemplate}>
                <SelectTrigger className="h-8 w-auto gap-1.5 text-xs">
                  <FileText className="h-3.5 w-3.5" />
                  <SelectValue placeholder="Start from a template" />
                </SelectTrigger>
                <SelectContent>
                  {templateGroups.length === 0 ? (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">
                      No templates yet
                    </div>
                  ) : (
                    templateGroups.map(([category, items]) => (
                      <SelectGroup key={category}>
                        <SelectLabel className="capitalize">
                          {category}
                        </SelectLabel>
                        {items.map((t) => (
                          <SelectItem key={t.id} value={t.id}>
                            {t.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
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
            {isEdit ? "Save changes" : "Create subagent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <ConfirmDialog
      open={pendingInstructions !== null}
      onOpenChange={(open) => !open && setPendingInstructions(null)}
      title="Replace instructions?"
      description="This will overwrite the current instructions. This can't be undone."
      confirmLabel="Replace"
      onConfirm={() => {
        if (pendingInstructions !== null) {
          setForm((prev) => ({ ...prev, instructions: pendingInstructions }))
        }
        setPendingInstructions(null)
      }}
    />
    </>
  )
}
