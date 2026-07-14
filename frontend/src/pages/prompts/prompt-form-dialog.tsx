import { useEffect, useState } from "react"
import { toast } from "sonner"

import type { PromptTemplate, PromptTemplateInput } from "@/api/types"
import {
  useCreatePromptTemplate,
  useUpdatePromptTemplate,
} from "@/api/prompt-templates"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/responsive-dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"

interface FormState {
  name: string
  description: string
  category: string
  content: string
}

const EMPTY: FormState = {
  name: "",
  description: "",
  category: "general",
  content: "",
}

interface PromptFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** When set, prefill the form. A template with no id is treated as a new (duplicated) draft. */
  template?: PromptTemplate
}

export function PromptFormDialog({
  open,
  onOpenChange,
  template,
}: PromptFormDialogProps) {
  const [form, setForm] = useState<FormState>(EMPTY)
  const createTemplate = useCreatePromptTemplate()
  const updateTemplate = useUpdatePromptTemplate()

  // A template with an id is an edit; a prefilled one without an id is a
  // duplicate draft (built-ins are read-only, so we save a fresh copy).
  const isEdit = Boolean(template?.id)
  const isSaving = createTemplate.isPending || updateTemplate.isPending

  useEffect(() => {
    if (open) {
      setForm(
        template
          ? {
              name: template.name,
              description: template.description,
              category: template.category,
              content: template.content,
            }
          : EMPTY
      )
    }
  }, [open, template])

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSubmit() {
    if (!form.name.trim()) {
      toast.error("Name is required")
      return
    }
    const input: PromptTemplateInput = {
      name: form.name.trim(),
      description: form.description.trim(),
      category: form.category.trim() || "general",
      content: form.content,
    }
    try {
      if (template?.id) {
        await updateTemplate.mutateAsync({ id: template.id, input })
        toast.success("Template updated")
      } else {
        await createTemplate.mutateAsync(input)
        toast.success("Template created")
      }
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save template")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit template" : "New template"}</DialogTitle>
          <DialogDescription>
            Prompt templates are reusable system prompts you can apply to any
            agent.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="template-name">Name</Label>
              <Input
                id="template-name"
                value={form.name}
                onChange={(e) => update("name", e.target.value)}
                placeholder="Coding agent"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="template-category">Category</Label>
              <Input
                id="template-category"
                value={form.category}
                onChange={(e) => update("category", e.target.value)}
                placeholder="coding"
              />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="template-description">Description</Label>
            <Input
              id="template-description"
              value={form.description}
              onChange={(e) => update("description", e.target.value)}
              placeholder="Short summary of when to use this prompt"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="template-content">Prompt (markdown)</Label>
            <Textarea
              id="template-content"
              value={form.content}
              onChange={(e) => update("content", e.target.value)}
              className="min-h-[240px] font-mono text-xs"
              spellCheck={false}
              placeholder="You are a..."
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
            {isEdit ? "Save changes" : "Create template"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
