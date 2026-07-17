import {
  FileArrowUp,
  FolderOpen,
  Pencil,
  Plus,
  Trash,
  UploadSimple,
} from "@phosphor-icons/react"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import type { Skill, SkillScope } from "@/api/types"
import {
  type SkillScopeFilter,
  useDeleteSkill,
  useImportSkills,
  useSkills,
} from "@/api/skills"
import { useWorkspaces } from "@/api/workspaces"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { EmptyState } from "@/components/empty-state"
import { PageHeader } from "@/components/page-header"
import { SkillFormDialog } from "./skill-form-dialog"

const DESCRIPTION = "Reusable markdown instructions for your agents."

// The scope selector's value: "global", or a workspace id for that workspace's
// own skills. Global skills apply to every agent everywhere; workspace skills
// live in `<workspace>/.agents/skills/` and only apply while an agent runs there.
const GLOBAL = "global"

export function SkillsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const [scopeKey, setScopeKey] = useState<string>(GLOBAL)
  const workspacesQuery = useWorkspaces()

  const filter: SkillScopeFilter =
    scopeKey === GLOBAL
      ? { scope: "global" }
      : { scope: "workspace", workspace_id: scopeKey }
  const newSkillScope: SkillScope = scopeKey === GLOBAL ? "global" : "workspace"
  const newSkillWorkspaceId = scopeKey === GLOBAL ? null : scopeKey

  const { data: skills, isLoading, isError, error } = useSkills(filter)
  const deleteSkill = useDeleteSkill()
  const importSkills = useImportSkills()

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Skill | undefined>(undefined)
  const [toDelete, setToDelete] = useState<Skill | undefined>(undefined)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  // `webkitdirectory`/`directory` aren't in React's input types; set them on the
  // element so the picker selects a whole folder (and reports relative paths).
  useEffect(() => {
    const el = folderInputRef.current
    if (el) {
      el.setAttribute("webkitdirectory", "")
      el.setAttribute("directory", "")
    }
  }, [])

  function openCreate() {
    setEditing(undefined)
    setFormOpen(true)
  }

  async function importFiles(files: File[]) {
    if (files.length === 0) return
    try {
      const created = await importSkills.mutateAsync({ files, filter })
      toast.success(
        created.length === 1
          ? `Imported "${created[0].name}"`
          : `Imported ${created.length} skills`,
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to import skill")
    }
  }

  function handleInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    event.target.value = "" // allow re-importing the same selection
    void importFiles(files)
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

  const workspaces = workspacesQuery.data ?? []
  const scopeSelector = (
    <Select value={scopeKey} onValueChange={setScopeKey}>
      <SelectTrigger className="w-full sm:w-56">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={GLOBAL}>Global (all workspaces)</SelectItem>
        {workspaces.map((ws) => (
          <SelectItem key={ws.id} value={ws.id}>
            {ws.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )

  const action = (
    <div className="flex items-center gap-2">
      {scopeSelector}
      <input
        ref={fileInputRef}
        type="file"
        accept=".zip,.md,.markdown,.txt"
        className="hidden"
        onChange={handleInputChange}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleInputChange}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" disabled={importSkills.isPending}>
            <UploadSimple className="h-4 w-4" />
            {importSkills.isPending ? "Importing…" : "Import"}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() => setTimeout(() => folderInputRef.current?.click(), 0)}
          >
            <FolderOpen className="h-4 w-4" />
            From folder
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => setTimeout(() => fileInputRef.current?.click(), 0)}
          >
            <FileArrowUp className="h-4 w-4" />
            From file (.zip / .md)
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button onClick={openCreate}>
        <Plus className="h-4 w-4" />
        New skill
      </Button>
    </div>
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
          title={scopeKey === GLOBAL ? "No global skills yet" : "No workspace skills yet"}
          description={
            scopeKey === GLOBAL
              ? "Global skills apply to every agent, in every workspace."
              : "Workspace skills live in this workspace's folder and apply only while an agent runs here."
          }
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
                      <Trash className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                <CardDescription className="line-clamp-2">
                  {skill.description || "No description"}
                </CardDescription>
              </CardHeader>
              <CardContent className="mt-auto space-y-2">
                <p className="line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">
                  {skill.content || "Empty skill."}
                </p>
                {(skill.resources.length > 0 || skill.scripts.length > 0) && (
                  <div className="flex flex-wrap gap-1.5">
                    {skill.resources.length > 0 && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {skill.resources.length} resource
                        {skill.resources.length === 1 ? "" : "s"}
                      </span>
                    )}
                    {skill.scripts.length > 0 && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {skill.scripts.length} script
                        {skill.scripts.length === 1 ? "" : "s"}
                      </span>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <SkillFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        skill={editing}
        scope={newSkillScope}
        workspaceId={newSkillWorkspaceId}
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
