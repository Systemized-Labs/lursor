import { Copy, Lock, Pencil, Plus, Trash2 } from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import type { PromptTemplate } from "@/api/types"
import {
  useDeletePromptTemplate,
  usePromptTemplates,
} from "@/api/prompt-templates"
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
import { PromptFormDialog } from "./prompt-form-dialog"

const DESCRIPTION =
  "Reusable system prompts. Apply one to any agent, or duplicate a built-in to customize it."

/** A duplicated draft: same content, no id, name suffixed so it saves as new. */
function duplicateOf(template: PromptTemplate): PromptTemplate {
  return { ...template, id: "", name: `${template.name} (copy)`, is_builtin: false }
}

export function PromptsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { data: templates, isLoading, isError, error } = usePromptTemplates()
  const deleteTemplate = useDeletePromptTemplate()

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<PromptTemplate | undefined>(undefined)
  const [toDelete, setToDelete] = useState<PromptTemplate | undefined>(undefined)

  const grouped = useMemo(() => {
    const byCategory = new Map<string, PromptTemplate[]>()
    for (const t of templates ?? []) {
      const list = byCategory.get(t.category) ?? []
      list.push(t)
      byCategory.set(t.category, list)
    }
    return [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [templates])

  function openCreate() {
    setEditing(undefined)
    setFormOpen(true)
  }

  function openEdit(template: PromptTemplate) {
    setEditing(template)
    setFormOpen(true)
  }

  function openDuplicate(template: PromptTemplate) {
    setEditing(duplicateOf(template))
    setFormOpen(true)
  }

  async function confirmDelete() {
    if (!toDelete) return
    try {
      await deleteTemplate.mutateAsync(toDelete.id)
      toast.success("Template deleted")
      setToDelete(undefined)
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to delete template"
      )
    }
  }

  const action = (
    <Button onClick={openCreate}>
      <Plus className="h-4 w-4" />
      New template
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
        <PageHeader
          title="Prompt templates"
          description={DESCRIPTION}
          actions={action}
        />
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading templates…</p>
      ) : isError ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Failed to load templates"}
        </p>
      ) : !templates || templates.length === 0 ? (
        <EmptyState
          title="No templates yet"
          description="Create a prompt template to reuse across agents."
          action={
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" />
              New template
            </Button>
          }
        />
      ) : (
        <div className="space-y-8">
          {grouped.map(([category, items]) => (
            <section key={category} className="space-y-3">
              <h3 className="text-sm font-medium capitalize text-muted-foreground">
                {category}
              </h3>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((template) => (
                  <Card key={template.id} className="flex flex-col">
                    <CardHeader>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <CardTitle className="truncate">
                            {template.name}
                          </CardTitle>
                          {template.is_builtin ? (
                            <Badge variant="secondary" className="mt-1 gap-1">
                              <Lock className="h-3 w-3" />
                              Built-in
                            </Badge>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {template.is_builtin ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => openDuplicate(template)}
                              aria-label="Duplicate template"
                            >
                              <Copy className="h-4 w-4" />
                            </Button>
                          ) : (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => openDuplicate(template)}
                                aria-label="Duplicate template"
                              >
                                <Copy className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => openEdit(template)}
                                aria-label="Edit template"
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => setToDelete(template)}
                                aria-label="Delete template"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                      <CardDescription className="line-clamp-2">
                        {template.description || "No description"}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="mt-auto">
                      <p className="line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">
                        {template.content || "Empty template."}
                      </p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <PromptFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        template={editing}
      />

      <ConfirmDialog
        open={Boolean(toDelete)}
        onOpenChange={(open) => !open && setToDelete(undefined)}
        title="Delete template"
        description={
          toDelete
            ? `This will permanently delete "${toDelete.name}".`
            : undefined
        }
        confirmLabel="Delete"
        destructive
        loading={deleteTemplate.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  )
}
