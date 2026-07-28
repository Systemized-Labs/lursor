import { FilePlus, Sparkle, Trash } from "@phosphor-icons/react"
import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import { skillKeys, skillsApi, useDeleteSkillFile } from "@/api/skills"
import type { Skill } from "@/api/types"
import { EditorPane } from "@/components/files/editor-pane"
import { fileKind } from "@/components/files/file-icon"
import { useFileBuffers, type FileSource } from "@/components/files/file-buffers"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

/** The skill's own instructions file — always present, never deletable. */
const SKILL_FILE = "SKILL.md"

// What an agent can actually load from a skill folder, mirroring the discovery
// rules in `app/skills/store.py`. Anything else would be written to disk but stay
// invisible to the skill, so we refuse to create it.
const RESOURCE_EXTS = ["md", "json", "yaml", "yml", "csv", "xml", "txt"]
const SCRIPT_EXTS = ["py"]

interface SkillEditorDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  skill: Skill | undefined
  /** Trade the dialog for the workspace that owns these files (agent + terminal). */
  onOpenInWorkspace: (skill: Skill) => void
}

/**
 * The skill's folder in a fullscreen editor — `SKILL.md` plus every bundled
 * resource and script, in the same Monaco editor the workspace files use (tabs,
 * dirty state, ⌘S, markdown preview, diff view, auto-save).
 *
 * A skill is a folder of files, so editing one is a file-editing job rather than
 * a form: `SKILL.md` is shown as it is on disk, frontmatter included.
 */
export function SkillEditorDialog({
  open,
  onOpenChange,
  skill,
  onOpenInWorkspace,
}: SkillEditorDialogProps) {
  // The editor lives in a keyed child, so its buffers reset per skill; the count
  // of unsaved buffers is mirrored here to guard closing.
  const dirtyRef = useRef(0)

  /** Close, confirming first if buffers are dirty. Returns whether it closed. */
  function handleClose(): boolean {
    if (
      dirtyRef.current > 0 &&
      !window.confirm(
        `Discard unsaved changes to ${dirtyRef.current} file${
          dirtyRef.current === 1 ? "" : "s"
        }?`
      )
    ) {
      return false
    }
    dirtyRef.current = 0
    onOpenChange(false)
    return true
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      handleClose()
      return
    }
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="flex h-[95vh] w-[98vw] max-w-[1400px] flex-col gap-0 overflow-hidden p-0">
        {skill ? (
          <SkillEditor
            key={skill.id}
            skill={skill}
            onDirtyCount={(n) => {
              dirtyRef.current = n
            }}
            // Route the handoff through the same close guard, so leaving for the
            // workspace can't silently drop unsaved buffers.
            onOpenInWorkspace={() => {
              if (handleClose()) onOpenInWorkspace(skill)
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

interface SkillEditorProps {
  skill: Skill
  onDirtyCount: (count: number) => void
  onOpenInWorkspace: () => void
}

function SkillEditor({
  skill,
  onDirtyCount,
  onOpenInWorkspace,
}: SkillEditorProps) {
  const qc = useQueryClient()
  const deleteFile = useDeleteSkillFile()
  const [listHidden, setListHidden] = useState(false)
  const [creating, setCreating] = useState(false)

  // The skill's folder as a file source. Saves invalidate the skill list so the
  // sidebar (and the row's counts) pick up new files and renamed frontmatter.
  const source = useMemo<FileSource>(
    () => ({
      read: async (path) => {
        const { content } = await skillsApi.readFile(skill.id, path)
        return { content, is_binary: false, truncated: false }
      },
      write: async (path, content) => {
        await skillsApi.writeFile(skill.id, path, content)
        void qc.invalidateQueries({ queryKey: skillKeys.all })
      },
    }),
    [skill.id, qc]
  )

  const buffers = useFileBuffers(source)
  const { openFile, openFiles, closeFile } = buffers

  // Open the instructions file on entry — it's the point of the skill, and an
  // empty editor over a one-file folder would just be a click to nowhere.
  useEffect(() => {
    void openFile(SKILL_FILE, SKILL_FILE)
  }, [openFile])

  const dirtyCount = openFiles.filter((f) => f.dirty).length
  useEffect(() => {
    onDirtyCount(dirtyCount)
  }, [dirtyCount, onDirtyCount])

  async function createFile(rawName: string) {
    const path = rawName.trim().replace(/^\/+/, "")
    if (!path) return
    const ext = path.split(".").pop()?.toLowerCase() ?? ""
    if (![...RESOURCE_EXTS, ...SCRIPT_EXTS].includes(ext)) {
      toast.error(
        `Agents load ${RESOURCE_EXTS.map((e) => `.${e}`).join(", ")} resources and .py scripts — a .${ext || "?"} file would be invisible to this skill.`
      )
      return
    }
    if (path.toUpperCase() === SKILL_FILE.toUpperCase()) {
      toast.error("SKILL.md already exists")
      return
    }
    try {
      await skillsApi.writeFile(skill.id, path, "")
      void qc.invalidateQueries({ queryKey: skillKeys.all })
      setCreating(false)
      await openFile(path, path.split("/").pop() ?? path)
      toast.success(`Created ${path}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create file")
    }
  }

  async function removeFile(path: string) {
    if (!window.confirm(`Delete ${path} from this skill?`)) return
    try {
      await deleteFile.mutateAsync({ id: skill.id, path })
      closeFile(path)
      toast.success(`Deleted ${path}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete file")
    }
  }

  const editorPane = (
    <EditorPane
      buffers={buffers}
      sidebarHidden={listHidden}
      onToggleSidebar={() => setListHidden((prev) => !prev)}
      empty={
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <p className="text-sm font-medium text-foreground">No file open</p>
          <p className="max-w-xs text-xs text-muted-foreground">
            Pick a file on the right. SKILL.md holds the instructions the agent
            reads; resources and scripts are loaded on demand.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void openFile(SKILL_FILE, SKILL_FILE)}
          >
            Open SKILL.md
          </Button>
        </div>
      }
    />
  )

  return (
    <>
      <DialogHeader className="shrink-0 flex-row items-start gap-3 space-y-0 border-b border-border/60 px-4 py-3 pr-12 text-left">
        <div className="min-w-0 flex-1 space-y-0.5">
          <DialogTitle className="truncate text-base text-foreground">
            {skill.name}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {skill.origin === "local"
              ? `Lives in this workspace's ${skill.root || ".agents/skills"} folder.`
              : skill.origin === "external"
                ? `Read in place from ${skill.root} — another tool owns this folder.`
                : skill.link_target
                  ? `Linked from ${skill.link_target} — saving writes to that file, which ${skill.link_label} reads too.`
                  : "Lives in your skills catalog."}{" "}
            Editing SKILL.md updates the name and description too — they are its
            frontmatter.
          </DialogDescription>
        </div>
        {/* This dialog is the editor without the workspace around it. When the
            job needs an agent to write the thing, or a terminal to run a script
            it bundles, this is the way out. */}
        {/* A skill in a personal folder belongs to no workspace, so there is no
            file tree to send it to — it stays in this dialog. */}
        {skill.origin !== "external" && (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={onOpenInWorkspace}
            title="Open these files in a workspace, with an agent and a terminal"
          >
            <Sparkle className="h-4 w-4" />
            {skill.origin === "local" ? "Open in workspace" : "Open in Skill Studio"}
          </Button>
        )}
      </DialogHeader>

      <div className="flex min-h-0 flex-1 flex-col">
        {listHidden ? (
          <div className="flex min-h-0 flex-1 flex-col bg-card">{editorPane}</div>
        ) : (
          <ResizablePanelGroup
            direction="horizontal"
            autoSaveId="skill-editor"
            className="min-h-0 flex-1"
          >
            <ResizablePanel minSize={30} className="flex min-w-0 flex-col bg-card">
              {editorPane}
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel
              defaultSize={26}
              minSize={16}
              className="flex min-w-0 flex-col"
            >
              <SkillFileList
                skill={skill}
                activePath={buffers.activePath}
                creating={creating}
                onCreate={createFile}
                onSetCreating={setCreating}
                onOpen={(path) => void openFile(path, path.split("/").pop() ?? path)}
                onDelete={(path) => void removeFile(path)}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
      </div>
    </>
  )
}

interface SkillFileListProps {
  skill: Skill
  activePath?: string
  creating: boolean
  onCreate: (name: string) => void
  onSetCreating: (creating: boolean) => void
  onOpen: (path: string) => void
  onDelete: (path: string) => void
}

/**
 * The skill folder's files, grouped the way the agent sees them: the
 * instructions, then loadable resources, then runnable scripts. Deliberately not
 * a full tree — these three groups *are* what a skill exposes.
 */
function SkillFileList({
  skill,
  activePath,
  creating,
  onCreate,
  onSetCreating,
  onOpen,
  onDelete,
}: SkillFileListProps) {
  const groups: { label: string; hint: string; paths: string[] }[] = [
    { label: "Instructions", hint: "Always loaded", paths: [SKILL_FILE] },
    {
      label: "Resources",
      hint: "Read on demand",
      paths: skill.resources,
    },
    { label: "Scripts", hint: "Run on demand", paths: skill.scripts },
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border/40 px-2 pl-3">
        <span className="text-xs font-medium text-foreground">Files</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          aria-label="New file"
          title="New file in this skill"
          onClick={() => onSetCreating(true)}
        >
          <FilePlus className="h-4 w-4" />
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="py-1">
          {creating && (
            <div className="px-2 pb-2">
              <Input
                autoFocus
                placeholder="references/FORMS.md"
                className="h-7 text-xs"
                onKeyDown={(e) => {
                  if (e.key === "Enter") onCreate(e.currentTarget.value)
                  if (e.key === "Escape") onSetCreating(false)
                }}
                onBlur={(e) => {
                  if (!e.currentTarget.value.trim()) onSetCreating(false)
                }}
              />
              <p className="mt-1 text-[10px] text-muted-foreground">
                Enter to create. Use scripts/… for a runnable .py script.
              </p>
            </div>
          )}
          {groups.map((group) => (
            <div key={group.label} className="mb-1">
              <div className="flex items-baseline gap-1.5 px-3 py-1">
                <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </span>
                <span className="text-[10px] text-muted-foreground/70">
                  {group.hint}
                </span>
              </div>
              {group.paths.length === 0 ? (
                <p className="px-3 pb-1 text-xs text-muted-foreground/70">None</p>
              ) : (
                group.paths.map((path) => (
                  <FileRow
                    key={path}
                    path={path}
                    active={path === activePath}
                    deletable={path !== SKILL_FILE}
                    onOpen={() => onOpen(path)}
                    onDelete={() => onDelete(path)}
                  />
                ))
              )}
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

interface FileRowProps {
  path: string
  active: boolean
  deletable: boolean
  onOpen: () => void
  onDelete: () => void
}

function FileRow({ path, active, deletable, onOpen, onDelete }: FileRowProps) {
  const { Icon: Glyph } = fileKind(path.split("/").pop() ?? path)
  return (
    <div
      className={cn(
        "group relative flex items-center text-xs",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
      )}
    >
      {/* Active rail — the same "you are here" marker as the workspace tree. */}
      {active && <span className="absolute inset-y-0 left-0 w-0.5 bg-primary" />}
      <button
        type="button"
        onClick={onOpen}
        title={path}
        className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-3 pr-1 text-left outline-none"
      >
        <Glyph
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            active ? "text-foreground" : "text-muted-foreground/80"
          )}
        />
        <span className="truncate">{path}</span>
      </button>
      {deletable && (
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete ${path}`}
          title={`Delete ${path}`}
          className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-0 outline-none transition-opacity hover:bg-background/60 focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Trash className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}
