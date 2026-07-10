import { Pencil, Plus, Trash2 } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import type { Skill } from "@/api/types"
import { useDeleteSkill, useSkills } from "@/api/skills"
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
import { SkillFormDialog } from "./skill-form-dialog"

const DESCRIPTION = "Reusable markdown instructions for your agents."

export function SkillsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { data: skills, isLoading, isError, error } = useSkills()
  const deleteSkill = useDeleteSkill()

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Skill | undefined>(undefined)
  const [toDelete, setToDelete] = useState<Skill | undefined>(undefined)

  function openCreate() {
    setEditing(undefined)
    setFormOpen(true)
  }

  async function confirmDelete() {
    if (!toDelete) return
    try {
      await deleteSkill.mutateAsync(toDelete.id)
      toast.success("Skill deleted")
      setToDelete(undefined)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete skill")
    }
  }

  const action = (
    <Button onClick={openCreate}>
      <Plus className="h-4 w-4" />
      New skill
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
        <PageHeader title="Skills" description={DESCRIPTION} actions={action} />
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading skills…</p>
      ) : isError ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load skills"}
        </p>
      ) : !skills || skills.length === 0 ? (
        <EmptyState
          title="No skills yet"
          description="Create a skill to share instructions across agents."
          action={
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" />
              New skill
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {skills.map((skill) => (
            <Card key={skill.id} className="flex flex-col">
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="truncate">{skill.name}</CardTitle>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        setEditing(skill)
                        setFormOpen(true)
                      }}
                      aria-label="Edit skill"
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setToDelete(skill)}
                      aria-label="Delete skill"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <CardDescription className="line-clamp-2">
                  {skill.description || "No description"}
                </CardDescription>
              </CardHeader>
              <CardContent className="mt-auto">
                <p className="line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">
                  {skill.content || "Empty skill."}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <SkillFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        skill={editing}
      />

      <ConfirmDialog
        open={Boolean(toDelete)}
        onOpenChange={(open) => !open && setToDelete(undefined)}
        title="Delete skill"
        description={
          toDelete
            ? `This will permanently delete "${toDelete.name}".`
            : undefined
        }
        confirmLabel="Delete"
        destructive
        loading={deleteSkill.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  )
}
