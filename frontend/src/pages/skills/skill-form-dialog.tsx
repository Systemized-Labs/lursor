import { useEffect, useState } from "react"
import { toast } from "sonner"

import type { Skill, SkillInput, SkillScope } from "@/api/types"
import { useCreateSkill, useUpdateSkill } from "@/api/skills"
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
  content: string
}

const EMPTY: FormState = { name: "", description: "", content: "" }

interface SkillFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  skill?: Skill
  // Scope a newly-created skill lands in (ignored when editing — a skill's scope
  // is fixed once created). Defaults to global.
  scope?: SkillScope
  workspaceId?: string | null
}

export function SkillFormDialog({
  open,
  onOpenChange,
  skill,
  scope = "global",
  workspaceId = null,
}: SkillFormDialogProps) {
  const [form, setForm] = useState<FormState>(EMPTY)
  const createSkill = useCreateSkill()
  const updateSkill = useUpdateSkill()
  const isEdit = Boolean(skill)
  const isSaving = createSkill.isPending || updateSkill.isPending

  useEffect(() => {
    if (open) {
      setForm(
        skill
          ? {
              name: skill.name,
              description: skill.description,
              content: skill.content,
            }
          : EMPTY
      )
    }
  }, [open, skill])

  async function handleSubmit() {
    if (!form.name.trim()) {
      toast.error("Name is required")
      return
    }
    const input: SkillInput = {
      name: form.name.trim(),
      description: form.description.trim(),
      content: form.content,
    }
    try {
      if (skill) {
        // Scope is immutable after creation; only send content fields.
        await updateSkill.mutateAsync({ id: skill.id, input })
        toast.success("Skill updated")
      } else {
        await createSkill.mutateAsync({
          ...input,
          scope,
          workspace_id: scope === "workspace" ? workspaceId : null,
        })
        toast.success("Skill created")
      }
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save skill")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit skill" : "New skill"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Skills are reusable markdown instructions agents can load."
              : scope === "workspace"
                ? "Creating a workspace skill — it lives in this workspace's folder and applies only there."
                : "Creating a global skill — it applies to every agent in every workspace."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="skill-name">Name</Label>
            <Input
              id="skill-name"
              value={form.name}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, name: e.target.value }))
              }
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="skill-description">Description</Label>
            <Input
              id="skill-description"
              value={form.description}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, description: e.target.value }))
              }
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="skill-content">Content (markdown)</Label>
            <Textarea
              id="skill-content"
              value={form.content}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, content: e.target.value }))
              }
              className="min-h-[200px] font-mono text-xs"
              spellCheck={false}
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
            {isEdit ? "Save changes" : "Create skill"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
