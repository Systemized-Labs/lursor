import {
  FileArrowUp,
  FolderOpen,
  Plus,
  Sparkle,
  UploadSimple,
} from "@phosphor-icons/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { toast } from "sonner"

import {
  type SkillTarget,
  useCopySkill,
  useLinkSkill,
  useDeleteSkill,
  useImportSkills,
  usePromoteSkill,
  useSkills,
  useUpdateSkill,
} from "@/api/skills"
import type { Skill } from "@/api/types"
import { useWorkspaces } from "@/api/workspaces"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { EmptyState } from "@/components/empty-state"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { revealSkill, skillLocation } from "@/lib/skill-location"
import { HeaderActions } from "@/pages/customization/header-actions"
import { SkillCreateDialog } from "./skill-create-dialog"
import { SkillDetailPanel } from "./skill-detail-panel"
import { SkillEditorDialog } from "./skill-editor-dialog"
import {
  ANYWHERE,
  appliesInWorkspace,
  SkillRail,
  type SelectSource,
} from "./skill-rail"

// New skills and imports land in the catalog applying everywhere; narrowing is a
// field in the detail pane. Reach is an assignment, so nothing here decides a
// location.
const IMPORT_TARGET: SkillTarget = { origin: "managed", is_global: true }

// Seeds the Skill Studio composer. Landing on an empty chat rooted in a
// directory tells you nothing about what to do with it; landing on a half-typed
// sentence does. Deliberately unfinished — the cursor sits where you continue.
const STUDIO_DRAFT = "Write me a skill that "

/**
 * The skill's folder as something a person can find, for the confirmations that
 * touch real files. Deleting `~/.claude/skills/pdf` from here removes it from
 * Claude Code, and that should be legible before the click, not after.
 */
function folderHint(skill: Skill, workspaceNames: Map<string, string>): string | null {
  if (skill.link_target) return skill.link_target
  if (skill.origin === "external") return `${skill.root}/${skill.slug}`
  if (skill.origin !== "local") return null
  const workspace = workspaceNames.get(skill.workspace_id ?? "") ?? "its workspace"
  return `${skill.root || ".agents/skills"}/${skill.slug} in ${workspace}`
}

/**
 * Narrowest container that can hold two panes: below it the rail takes the full
 * width and the detail side arrives as a sheet.
 *
 * Measured on the container rather than the viewport, because the app sidebar
 * takes its cut before this page sees any width — a 768px window with the
 * sidebar open leaves ~470px here, which is a phone's worth of room.
 */
const TWO_PANE_MIN_WIDTH = 720

/** Breathing room below the browser, so it doesn't sit flush to the fold. */
const BOTTOM_GUTTER = 24

/** Floor, for a window too short to honour the measurement. */
const MIN_HEIGHT = 280

interface BrowserBox {
  /** Pixels, so the box ends just above the fold whatever sits above it. */
  height: number
  narrow: boolean
}

function measureBox(el: HTMLElement): BrowserBox {
  const rect = el.getBoundingClientRect()
  return {
    height: Math.max(MIN_HEIGHT, window.innerHeight - rect.top - BOTTOM_GUTTER),
    narrow: rect.width < TWO_PANE_MIN_WIDTH,
  }
}

/**
 * How tall the browser should be, and whether it gets two panes.
 *
 * The page sits in a padded, scrolling column with no definite height, so the
 * two panes can't just be `flex-1` — the box needs a real height to scroll its
 * halves independently. That used to be a `calc(100svh - Nrem)` with `N`
 * measured by hand, which breaks the moment anything above changes height: the
 * tab strip above wraps onto a second row at some widths, moving this box 50px
 * down. So measure the gap to the fold instead of encoding it.
 */
function useBrowserBox(ref: React.RefObject<HTMLDivElement | null>): BrowserBox {
  const [box, setBox] = useState<BrowserBox>({
    height: MIN_HEIGHT,
    narrow: false,
  })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const next = measureBox(el)
      // Bail on an unchanged result: this observes the element whose height it
      // sets, so a new object every time would loop.
      setBox((prev) =>
        prev.height === next.height && prev.narrow === next.narrow ? prev : next
      )
    }
    // Width changes reach us through the observer (the sidebar collapsing, the
    // window resizing); `resize` also covers a height-only window change, which
    // moves the fold without resizing anything here.
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    window.addEventListener("resize", measure)
    measure()
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [ref])
  return box
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

/**
 * The skills manager as a two-pane browser: a dense, filterable rail of every
 * skill beside a detail pane that holds every control the old row crammed into
 * one line.
 *
 * The rail sections by *source* rather than by reach, so re-pointing a skill from
 * the pane never moves the row you are looking at. The selection lives in the
 * URL (`?skill=<id>`), so a pane is deep-linkable and survives a reload.
 */
export function SkillsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [search, setSearch] = useState("")
  const [appliesIn, setAppliesIn] = useState<string>(ANYWHERE)
  const containerRef = useRef<HTMLDivElement>(null)
  const { height: browserHeight, narrow } = useBrowserBox(containerRef)

  const { data: skills, isLoading, isError, error } = useSkills()
  const workspacesQuery = useWorkspaces()
  const deleteSkill = useDeleteSkill()
  const promoteSkill = usePromoteSkill()
  const copySkill = useCopySkill()
  const linkSkill = useLinkSkill()
  const updateSkill = useUpdateSkill()
  const importSkills = useImportSkills()

  const navigate = useNavigate()
  const [createOpen, setCreateOpen] = useState(false)
  // The skill being edited is tracked by id and re-read from the list, so saving
  // SKILL.md (which can rename the skill) updates the editor's own header.
  const [editingId, setEditingId] = useState<string | undefined>(undefined)
  // With no room for two panes the detail side becomes a sheet, opened by tapping
  // a row. Selection alone must not open it, or a deep link would land you on top
  // of the rail you are trying to read.
  const [detailOpen, setDetailOpen] = useState(false)
  const [toDelete, setToDelete] = useState<Skill | undefined>(undefined)
  const [toPromote, setToPromote] = useState<Skill | undefined>(undefined)
  const [toCopy, setToCopy] = useState<Skill | undefined>(undefined)
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

  const selectedId = searchParams.get("skill") ?? undefined
  const selected = skills?.find((s) => s.id === selectedId)

  const filtered = useMemo(
    () =>
      (skills ?? []).filter(
        (skill) =>
          matches(skill, search) &&
          (appliesIn === ANYWHERE || appliesInWorkspace(skill, appliesIn))
      ),
    [skills, search, appliesIn]
  )

  const selectSkill = useCallback(
    (skill: Skill | undefined, source: SelectSource) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (skill) next.set("skill", skill.id)
          else next.delete("skill")
          return next
        },
        { replace: true }
      )
      if (narrow && source === "pointer" && skill) setDetailOpen(true)
    },
    [narrow, setSearchParams]
  )

  // `webkitdirectory`/`directory` aren't in React's input types; set them on the
  // element so the picker selects a whole folder (and reports relative paths).
  useEffect(() => {
    const el = folderInputRef.current
    if (el) {
      el.setAttribute("webkitdirectory", "")
      el.setAttribute("directory", "")
    }
  }, [])

  const openEdit = useCallback((skill: Skill) => {
    setEditingId(skill.id)
  }, [])

  /** Leave the manager for the workspace that owns this skill's files. */
  const openInWorkspace = useCallback(
    (skill: Skill) => {
      const location = skillLocation(skill, workspaces)
      if (!location) {
        toast.error("No workspace can open this skill yet")
        return
      }
      setEditingId(undefined) // in case we came from the editor dialog
      navigate(revealSkill(location))
    },
    [navigate, workspaces]
  )

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
      // The rail hands the selection to whatever takes the deleted row's place.
      setDetailOpen(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete skill")
    }
  }

  // No confirm: it changes nothing on disk and the switch itself is the undo.
  const toggleEnabled = useCallback(
    async (skill: Skill, enabled: boolean) => {
      try {
        await updateSkill.mutateAsync({ id: skill.id, input: { enabled } })
      } catch (err) {
        toast.error(
          err instanceof Error
            ? err.message
            : `Failed to ${enabled ? "enable" : "disable"} skill`
        )
      }
    },
    [updateSkill]
  )

  // No confirm: nothing is copied, moved or overwritten — a pointer is added, and
  // Unlink in the same menu removes it again.
  const link = useCallback(
    async (skill: Skill) => {
      try {
        const linked = await linkSkill.mutateAsync(skill.id)
        toast.success(
          `"${linked.name}" linked into the catalog — still reading ${linked.link_label}`
        )
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to link skill")
      }
    },
    [linkSkill]
  )

  async function confirmCopy() {
    if (!toCopy) return
    try {
      const copied = await copySkill.mutateAsync(toCopy.id)
      toast.success(
        `"${copied.name}" copied into the catalog — the original is untouched`
      )
      setToCopy(undefined)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to copy skill")
    }
  }

  async function confirmPromote() {
    if (!toPromote) return
    try {
      const promoted = await promoteSkill.mutateAsync(toPromote.id)
      toast.success(
        `"${promoted.name}" moved into the catalog — assign it from the Applies in field`
      )
      setToPromote(undefined)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to move skill")
    }
  }

  // Rendered into the Customization header rather than a toolbar row of their
  // own, so the browser starts directly under the tab strip.
  const actions = (
    <HeaderActions>
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
      <Button onClick={() => setCreateOpen(true)}>
        <Plus className="h-4 w-4" />
        New skill
      </Button>
    </HeaderActions>
  )

  const rail = (
    <SkillRail
      skills={filtered}
      total={(skills ?? []).length}
      workspaces={workspaces}
      workspaceNames={workspaceNames}
      search={search}
      onSearchChange={setSearch}
      appliesIn={appliesIn}
      onAppliesInChange={setAppliesIn}
      selectedId={selectedId}
      onSelect={selectSkill}
      onActivate={openEdit}
    />
  )

  const detail = selected ? (
    <SkillDetailPanel
      key={selected.id}
      skill={selected}
      workspaces={workspaces}
      workspaceNames={workspaceNames}
      onEdit={openEdit}
      onOpenInWorkspace={openInWorkspace}
      onPromote={setToPromote}
      onCopy={setToCopy}
      onLink={link}
      onToggle={toggleEnabled}
      onDelete={setToDelete}
    />
  ) : null

  function clearFilters() {
    setSearch("")
    setAppliesIn(ANYWHERE)
  }

  const emptyPane = (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="text-sm font-medium text-foreground">
        {filtered.length === 0 ? "Nothing matches these filters" : "No skill selected"}
      </p>
      <p className="max-w-xs text-xs text-muted-foreground">
        {filtered.length === 0
          ? "Widen the search or set Applies in back to Anywhere."
          : "Pick a skill on the left to see where it applies and what it tells the agent."}
      </p>
      {filtered.length === 0 ? (
        <Button variant="outline" size="sm" onClick={clearFilters}>
          Clear filters
        </Button>
      ) : null}
    </div>
  )

  return (
    // The ref is the two-pane measurement: this element is always mounted and
    // always the full width the page has to work with.
    <div ref={containerRef}>
      {actions}

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
      ) : narrow ? (
        // One column: the rail owns the width, the pane arrives as a sheet.
        <div
          style={{ height: browserHeight }}
          className="flex flex-col overflow-hidden rounded-lg border"
        >
          {rail}
        </div>
      ) : (
        <div
          style={{ height: browserHeight }}
          className="overflow-hidden rounded-lg border"
        >
          <ResizablePanelGroup direction="horizontal" autoSaveId="skills-browser">
            <ResizablePanel
              defaultSize={28}
              minSize={20}
              className="flex min-w-0 flex-col"
            >
              {rail}
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel minSize={40} className="flex min-w-0 flex-col">
              {detail ?? emptyPane}
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      )}

      <Sheet
        open={narrow && detailOpen && Boolean(selected)}
        onOpenChange={setDetailOpen}
      >
        <SheetContent
          side="right"
          // The sheet's own close button sits top-right, where the pane header's
          // actions menu lives — keep them out of each other's way.
          className="flex w-full flex-col gap-0 p-0 sm:max-w-md [&_[data-slot=skill-detail-header]]:pr-12"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>{selected?.name ?? "Skill"}</SheetTitle>
          </SheetHeader>
          {detail}
        </SheetContent>
      </Sheet>

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
            ? `This moves ${folderHint(toPromote, workspaceNames)} into your skills catalog, so it can be assigned to any workspace. The files leave the repo — commit or stash first if that matters.`
            : undefined
        }
        confirmLabel="Move"
        loading={promoteSkill.isPending}
        onConfirm={confirmPromote}
      />

      <ConfirmDialog
        open={Boolean(toCopy)}
        onOpenChange={(open) => !open && setToCopy(undefined)}
        title="Copy skill to catalog"
        description={
          toCopy
            ? `This copies ${folderHint(toCopy, workspaceNames)} into your skills catalog, where you can edit and reassign it freely. The original stays exactly where it is — ${
                toCopy.origin === "external"
                  ? "the tool that owns it keeps using it"
                  : "nothing in the repo changes"
              }. Both copies will be in scope until you narrow the new one.`
            : undefined
        }
        confirmLabel="Copy"
        loading={copySkill.isPending}
        onConfirm={confirmCopy}
      />

      {/* A linked skill's files are somebody else's, and deleting it removes them
          there too — so it gets the same warning a discovered skill has always
          had, naming the path, rather than the softer copy its catalog origin
          would otherwise earn it. */}
      <ConfirmDialog
        open={Boolean(toDelete)}
        onOpenChange={(open) => !open && setToDelete(undefined)}
        title="Delete skill"
        description={
          toDelete
            ? toDelete.link_target
              ? `This deletes the real folder at ${toDelete.link_target}. It is linked, not copied, so "${toDelete.name}" will disappear from ${toDelete.link_label} as well. Switch it off instead to keep the files and stop loading it.`
              : toDelete.is_owned_root
                ? `This will permanently delete "${toDelete.name}".`
                : `This deletes the real folder at ${folderHint(toDelete, workspaceNames)}, which ${
                    toDelete.origin === "external"
                      ? "other tools read too — it will disappear from them as well"
                      : "is part of the repo — commit or stash first if that matters"
                  }.`
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
