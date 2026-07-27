import { useEffect, useState } from "react"
import { toast } from "sonner"

import { useCreateSkill } from "@/api/skills"
import type { Skill } from "@/api/types"
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

interface SkillCreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Hand the new skill back so the caller can open it in the editor. */
  onCreated: (skill: Skill) => void
}

/**
 * Just enough to create the folder: a name and the description agents read when
 * deciding whether to load the skill. Everything else is its own action — the
 * instructions and bundled files are written in the editor, and where it applies
 * and which variables it gets are set from the skill's row.
 */
export function SkillCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: SkillCreateDialogProps) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const createSkill = useCreateSkill()

  useEffect(() => {
    if (open) {
      setName("")
      setDescription("")
    }
  }, [open])

  async function handleSubmit() {
    if (!name.trim()) {
      toast.error("Name is required")
      return
    }
    try {
      const created = await createSkill.mutateAsync({
        name: name.trim(),
        description: description.trim(),
        content: "",
      })
      toast.success(`"${created.name}" created — applies everywhere`)
      onOpenChange(false)
      onCreated(created)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create skill")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New skill</DialogTitle>
          <DialogDescription>
            Creating it opens the editor so you can write the instructions. It
            starts out applying everywhere — narrow that from its row.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="new-skill-name">Name</Label>
            <Input
              id="new-skill-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSubmit()
              }}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-skill-description">Description</Label>
            <Textarea
              id="new-skill-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="min-h-[80px]"
              placeholder="When should an agent reach for this skill?"
            />
            <p className="text-xs text-muted-foreground">
              Agents see this before the instructions, so it decides whether the
              skill gets used at all.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={createSkill.isPending}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={createSkill.isPending}>
            {createSkill.isPending ? "Creating…" : "Create and edit"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
