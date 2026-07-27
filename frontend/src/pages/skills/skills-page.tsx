import {
  ArrowLineUp,
  DotsThree,
  FileArrowUp,
  FolderOpen,
  MagnifyingGlass,
  Pencil,
  Plus,
  Sparkle,
  Trash,
  UploadSimple,
} from "@phosphor-icons/react"
import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { toast } from "sonner"

import {
  type SkillTarget,
  useDeleteSkill,
  useImportSkills,
  usePromoteSkill,
  useSkills,
} from "@/api/skills"
import type { Skill, Workspace } from "@/api/types"
import { useWorkspaces } from "@/api/workspaces"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { EmptyState } from "@/components/empty-state"
import { PageHeader } from "@/components/page-header"
import { Button } from "@/components/ui/button"
import { revealSkill, skillLocation } from "@/lib/skill-location"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SkillCreateDialog } from "./skill-create-dialog"
import { SkillEditorDialog } from "./skill-editor-dialog"
import { SkillEnvMenu } from "./skill-env-menu"
import { SkillScopeMenu } from "./skill-scope-menu"

const DESCRIPTION =
  "Reusable markdown instructions agents load on their own. One copy in your catalog — point it at whatever should use it."

// New skills and imports land in the catalog applying everywhere; narrowing is a
// click on the row. Reach is an assignment, so nothing here decides a location.
const IMPORT_TARGET: SkillTarget = { origin: "managed", is_global: true }

// Seeds the Skill Studio composer. Landing on an empty chat rooted in a
// directory tells you nothing about what to do with it; landing on a half-typed
// sentence does. Deliberately unfinished — the cursor sits where you continue.
const STUDIO_DRAFT = "Write me a skill that "

/** Where a skill applies, as the four buckets the page is organised into. */
type GroupKey = "global" | "assigned" | "local" | "unassigned"

const GROUPS: { key: GroupKey; title: string; hint: string }[] = [
  {
    key: "global",
    title: "Everywhere",
    hint: "Loaded by every agent, in every workspace.",
  },
  {
    key: "assigned",
    title: "Specific workspaces",
    hint: "Loaded only by agents running in the workspaces you picked.",
  },
  {
    key: "local",
    title: "In a repo",
    hint: "Committed under .agents/skills — travels with the code and applies only there.",
  },
  {
    key: "unassigned",
    title: "Not assigned",
    hint: "Kept in your catalog, loaded by nothing. Park skills here instead of deleting them.",
  },
]

function groupOf(skill: Skill): GroupKey {
  if (skill.origin === "local") return "local"
  if (skill.is_global) return "global"
  return skill.workspace_ids.length > 0 ? "assigned" : "unassigned"
}

function matches(skill: Skill, query: string): boolean {
  if (!query) return true
  const needle = query.toLowerCase()
  return (
    skill.name.toLowerCase().includes(needle) ||
    skill.slug.toLowerCase().includes(needle) ||
    skill.description.toLowerCase().includes(needle)
  )
}

/** Small muted pill for a row's file counts. */
function Chip({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
    >
      {children}
    </span>
  )
}

interface SkillRowProps {
  skill: Skill
  workspaces: Workspace[]
  workspaceNames: Map<string, string>
  onEdit: (skill: Skill) => void
  onOpenInWorkspace: (skill: Skill) => void
  onPromote: (skill: Skill) => void
  onDelete: (skill: Skill) => void
}

function SkillRow({
  skill,
  workspaces,
  workspaceNames,
  onEdit,
  onOpenInWorkspace,
  onPromote,
  onDelete,
}: SkillRowProps) {
  const isLocal = skill.origin === "local"
  const fileCount = skill.resources.length + skill.scripts.length

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40">
      <button
        type="button"
        onClick={() => onEdit(skill)}
        className="min-w-0 flex-1 text-left"
        title="Open this skill's files"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-sm font-medium text-foreground">
            {skill.name}
          </span>
          {fileCount > 0 && (
            <Chip
              title={[...skill.resources, ...skill.scripts].join("\n")}
            >
              {/* SKILL.md is always there, so only the bundled extras are news. */}
              {fileCount + 1} files
            </Chip>
          )}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {skill.description || "No description"}
        </p>
      </button>

      <div className="flex shrink-0 items-center gap-1">
        {isLocal ? (
          <span
            className="hidden max-w-[12rem] truncate rounded-md border px-2 py-1 text-xs text-muted-foreground sm:inline-block"
            title="Lives in this workspace's .agents/skills folder. Move it to the catalog to assign it elsewhere."
          >
            {workspaceNames.get(skill.workspace_id ?? "") ?? "Unknown workspace"}
          </span>
        ) : (
          <SkillScopeMenu skill={skill} workspaces={workspaces} />
        )}
        <SkillEnvMenu skill={skill} />
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={() => onEdit(skill)}
          aria-label="Edit skill files"
          title="Open this skill's files"
        >
          <Pencil className="h-4 w-4" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              aria-label="Skill actions"
            >
              <DotsThree className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onEdit(skill)}>
              <Pencil className="h-4 w-4" />
              Edit files
            </DropdownMenuItem>
            {/* The same files, in a workspace: an agent that can rewrite them, a
                terminal to run the scripts, and every sibling skill to crib
                from. Local skills open in the repo that owns them. */}
            <DropdownMenuItem onSelect={() => onOpenInWorkspace(skill)}>
              <Sparkle className="h-4 w-4" />
              {isLocal ? "Open in workspace" : "Open in Skill Studio"}
            </DropdownMenuItem>
            {isLocal && (
              <DropdownMenuItem onSelect={() => onPromote(skill)}>
                <ArrowLineUp className="h-4 w-4" />
                Move to catalog
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onDelete(skill)}>
              <Trash className="h-4 w-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

export function SkillsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const [search, setSearch] = useState("")
  const { data: skills, isLoading, isError, error } = useSkills()
  const workspacesQuery = useWorkspaces()
  const deleteSkill = useDeleteSkill()
  const promoteSkill = usePromoteSkill()
  const importSkills = useImportSkills()

  const navigate = useNavigate()
  const [createOpen, setCreateOpen] = useState(false)
  // The skill being edited is tracked by id and re-read from the list, so saving
  // SKILL.md (which can rename the skill) updates the editor's own header.
  const [editingId, setEditingId] = useState<string | undefined>(undefined)
  const [toDelete, setToDelete] = useState<Skill | undefined>(undefined)
  const [toPromote, setToPromote] = useState<Skill | undefined>(undefined)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  const workspaces = useMemo(
    () => workspacesQuery.data ?? [],
    [workspacesQuery.data]
  )
  const workspaceNames = useMemo(
    () => new Map(workspaces.map((ws) => [ws.id, ws.name])),
    [workspaces]
  )
  // The catalog directory registered as a workspace: chat, a file tree over
  // every skill, and a terminal to run their scripts. Registered at startup, so
  // it is only missing if the backend hasn't finished booting.
  const skillsWorkspace = workspaces.find((ws) => ws.is_system)
  const studioHref = skillsWorkspace
    ? `/workspaces/${skillsWorkspace.id}/chat?draft=${encodeURIComponent(STUDIO_DRAFT)}`
    : null
  const editing = skills?.find((s) => s.id === editingId)

  // Groups replace the old scope dropdown: every skill is visible at once, sorted
  // by name within the bucket that says where it applies.
  const grouped = useMemo(() => {
    const buckets = new Map<GroupKey, Skill[]>()
    for (const skill of skills ?? []) {
      if (!matches(skill, search)) continue
      const key = groupOf(skill)
      buckets.set(key, [...(buckets.get(key) ?? []), skill])
    }
    return GROUPS.map((group) => ({
      ...group,
      items: (buckets.get(group.key) ?? []).sort((a, b) =>
        a.name.localeCompare(b.name)
      ),
    })).filter((group) => group.items.length > 0)
  }, [skills, search])

  // `webkitdirectory`/`directory` aren't in React's input types; set them on the
  // element so the picker selects a whole folder (and reports relative paths).
  useEffect(() => {
    const el = folderInputRef.current
    if (el) {
      el.setAttribute("webkitdirectory", "")
      el.setAttribute("directory", "")
    }
  }, [])

  function openEdit(skill: Skill) {
    setEditingId(skill.id)
  }

  /** Leave the manager for the workspace that owns this skill's files. */
  function openInWorkspace(skill: Skill) {
    const location = skillLocation(skill, workspaces)
    if (!location) {
      toast.error("No workspace can open this skill yet")
      return
    }
    setEditingId(undefined) // in case we came from the editor dialog
    navigate(revealSkill(location))
  }

  async function importFiles(files: File[]) {
    if (files.length === 0) return
    try {
      const created = await importSkills.mutateAsync({
        files,
        target: IMPORT_TARGET,
      })
      toast.success(
        created.length === 1
          ? `Imported "${created[0].name}"`
          : `Imported ${created.length} skills`
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

  async function confirmPromote() {
    if (!toPromote) return
    try {
      const promoted = await promoteSkill.mutateAsync(toPromote.id)
      toast.success(
        `"${promoted.name}" moved into the catalog — assign it from its row`
      )
      setToPromote(undefined)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to move skill")
    }
  }

  const action = (
    <div className="flex items-center gap-2">
      <div className="flex h-10 w-40 items-center gap-2 rounded-lg border border-transparent bg-muted/60 px-3 focus-within:border-ring/40 focus-within:bg-background sm:w-56">
        <MagnifyingGlass className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search skills..."
          aria-label="Search skills"
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>
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
      {studioHref ? (
        <Button variant="outline" asChild>
          <Link
            to={studioHref}
            title="Open Skill Studio — an agent, a terminal and the file tree over your whole catalog"
          >
            <Sparkle className="h-4 w-4" />
            Author with agent
          </Link>
        </Button>
      ) : null}
      <Button onClick={() => setCreateOpen(true)}>
        <Plus className="h-4 w-4" />
        New skill
      </Button>
    </div>
  )

  return (
    <div className="space-y-6">
      {embedded ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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
      ) : (skills ?? []).length === 0 ? (
        <EmptyState
          title="No skills yet"
          description="A skill is a folder of instructions an agent loads when it is in scope. Describe one and have it written for you, start from a blank SKILL.md, or import a folder you already have."
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              {/* Agent-first: describing the first skill beats staring at an
                  empty frontmatter form when you've never written one. */}
              {studioHref ? (
                <Button asChild>
                  <Link to={studioHref}>
                    <Sparkle className="h-4 w-4" />
                    Describe a skill
                  </Link>
                </Button>
              ) : null}
              <Button
                variant={studioHref ? "outline" : "default"}
                onClick={() => setCreateOpen(true)}
              >
                <Plus className="h-4 w-4" />
                New skill
              </Button>
            </div>
          }
        />
      ) : grouped.length === 0 ? (
        <EmptyState
          title={`No skills match "${search}"`}
          action={
            <Button variant="outline" onClick={() => setSearch("")}>
              Clear search
            </Button>
          }
        />
      ) : (
        <div className="space-y-6">
          {grouped.map((group) => (
            <section key={group.key} className="space-y-2">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <h3 className="text-sm font-medium text-foreground">
                  {group.title}
                </h3>
                <span className="text-xs text-muted-foreground">
                  {group.items.length}
                </span>
                <p className="text-xs text-muted-foreground">· {group.hint}</p>
              </div>
              <div className="divide-y overflow-hidden rounded-md border">
                {group.items.map((skill) => (
                  <SkillRow
                    key={skill.id}
                    skill={skill}
                    workspaces={workspaces}
                    workspaceNames={workspaceNames}
                    onEdit={openEdit}
                    onOpenInWorkspace={openInWorkspace}
                    onPromote={setToPromote}
                    onDelete={setToDelete}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <SkillCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(created) => setEditingId(created.id)}
      />

      <SkillEditorDialog
        open={Boolean(editing)}
        onOpenChange={(open) => !open && setEditingId(undefined)}
        skill={editing}
        onOpenInWorkspace={openInWorkspace}
      />

      <ConfirmDialog
        open={Boolean(toPromote)}
        onOpenChange={(open) => !open && setToPromote(undefined)}
        title="Move skill to catalog"
        description={
          toPromote
            ? `This moves the "${toPromote.name}" folder out of ${
                workspaceNames.get(toPromote.workspace_id ?? "") ?? "the workspace"
              }'s .agents/skills and into your skills catalog, so it can be assigned to any workspace. The files leave the repo — commit or stash first if that matters.`
            : undefined
        }
        confirmLabel="Move"
        loading={promoteSkill.isPending}
        onConfirm={confirmPromote}
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
