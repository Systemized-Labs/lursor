import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  CaretRight,
  Folder,
  FolderOpen,
  FolderSimpleDashed,
  FilePlus,
  FolderPlus,
  Pencil,
  Trash,
  UploadSimple,
} from "@phosphor-icons/react"
import { toast } from "sonner"

import { filesApi, useDirectory } from "@/api/files"
import type { DirEntry } from "@/api/files"
import { ApiError } from "@/api/client"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

import { fileKind } from "./file-icon"
import { SkillIngestMenu } from "./skill-ingest-menu"

/** Left indent per tree level; row text starts one step in from the panel edge. */
const INDENT_STEP = 12
const BASE_INDENT = 8

/** The parent directory of a workspace-relative path ("" for a root-level item). */
function parentOf(path: string): string {
  const i = path.lastIndexOf("/")
  return i === -1 ? "" : path.slice(0, i)
}

/** Join a parent dir and a name into a workspace-relative path. */
function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

interface FileExplorerProps {
  workspaceId: string
  /** Currently active file path, highlighted in the tree. */
  activePath?: string
  /** Open a file in the editor. */
  onOpenFile: (path: string, name: string) => void
}

/** Shared actions + expansion state, passed down through the recursive tree. */
interface ExplorerContextValue {
  workspaceId: string
  activePath?: string
  onOpenFile: (path: string, name: string) => void
  isExpanded: (path: string) => boolean
  toggle: (path: string) => void
  requestCreate: (parentPath: string, isDir: boolean) => void
  requestUpload: (parentPath: string) => void
  requestRename: (entry: DirEntry) => void
  requestDelete: (entry: DirEntry) => void
}

const ExplorerContext = createContext<ExplorerContextValue | null>(null)

function useExplorer(): ExplorerContextValue {
  const ctx = useContext(ExplorerContext)
  if (!ctx) throw new Error("useExplorer must be used within FileExplorer")
  return ctx
}

/** A pending create/rename operation the name dialog is collecting input for. */
type Pending =
  | { mode: "create"; parentPath: string; isDir: boolean }
  | { mode: "rename"; entry: DirEntry }

/**
 * A lazily-loaded workspace file tree. Directories fetch their children on
 * first expand; the tree refreshes live as the query cache is invalidated by
 * the file watcher. Files open in the editor on click.
 *
 * Right-clicking a row (or the empty area, for root-level actions) opens a
 * context menu to create, rename, or delete files and folders — and, on a folder
 * holding a `SKILL.md`, to ingest it as a skill (see {@link SkillIngestMenu}).
 * Depth is drawn with hairline indent guides, and the active file carries a left
 * accent rail.
 */
export function FileExplorer({
  workspaceId,
  activePath,
  onOpenFile,
}: FileExplorerProps) {
  const qc = useQueryClient()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<Pending | null>(null)
  const [toDelete, setToDelete] = useState<DirEntry | null>(null)
  // Hidden native picker, reused for every upload; its target folder is stashed
  // in a ref between the menu click and the resulting `change` event.
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const uploadTarget = useRef<string>("")

  const invalidateTree = useCallback(
    () => qc.invalidateQueries({ queryKey: ["files", workspaceId, "dir"] }),
    [qc, workspaceId]
  )

  const isExpanded = useCallback((path: string) => expanded.has(path), [expanded])

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const expand = useCallback((path: string) => {
    if (!path) return
    setExpanded((prev) => (prev.has(path) ? prev : new Set(prev).add(path)))
  }, [])

  const requestCreate = useCallback((parentPath: string, isDir: boolean) => {
    setPending({ mode: "create", parentPath, isDir })
  }, [])
  const requestUpload = useCallback((parentPath: string) => {
    uploadTarget.current = parentPath
    // Reset first so re-picking the same files still fires `change`.
    if (uploadInputRef.current) uploadInputRef.current.value = ""
    uploadInputRef.current?.click()
  }, [])
  const requestRename = useCallback((entry: DirEntry) => {
    setPending({ mode: "rename", entry })
  }, [])
  const requestDelete = useCallback((entry: DirEntry) => setToDelete(entry), [])

  const createMut = useMutation({
    mutationFn: ({ path, isDir }: { path: string; isDir: boolean }) =>
      filesApi.create(workspaceId, path, isDir),
    onSuccess: (entry, vars) => {
      void invalidateTree()
      expand(parentOf(entry.path))
      // Open a freshly-created file so the user lands in it right away.
      if (!vars.isDir) onOpenFile(entry.path, entry.name)
    },
    onError: (err) => toast.error(errMessage(err, "Could not create")),
  })

  const uploadMut = useMutation({
    mutationFn: ({ parentPath, files }: { parentPath: string; files: File[] }) =>
      filesApi.upload(workspaceId, parentPath, files),
    onSuccess: (entries, vars) => {
      void invalidateTree()
      if (vars.parentPath) expand(vars.parentPath)
      const n = entries.length
      toast.success(`Uploaded ${n} file${n === 1 ? "" : "s"}`)
    },
    onError: (err) => toast.error(errMessage(err, "Could not upload")),
  })

  const renameMut = useMutation({
    mutationFn: ({ path, newPath }: { path: string; newPath: string }) =>
      filesApi.rename(workspaceId, path, newPath),
    onSuccess: () => void invalidateTree(),
    onError: (err) => toast.error(errMessage(err, "Could not rename")),
  })

  const deleteMut = useMutation({
    mutationFn: (path: string) => filesApi.remove(workspaceId, path),
    onSuccess: () => void invalidateTree(),
    onError: (err) => toast.error(errMessage(err, "Could not delete")),
  })

  const submitName = useCallback(
    (name: string) => {
      const trimmed = name.trim()
      if (!pending || !trimmed) return
      if (pending.mode === "create") {
        createMut.mutate({
          path: joinPath(pending.parentPath, trimmed),
          isDir: pending.isDir,
        })
      } else {
        const newPath = joinPath(parentOf(pending.entry.path), trimmed)
        if (newPath !== pending.entry.path) {
          renameMut.mutate({ path: pending.entry.path, newPath })
        }
      }
      setPending(null)
    },
    [pending, createMut, renameMut]
  )

  const ctx: ExplorerContextValue = {
    workspaceId,
    activePath,
    onOpenFile,
    isExpanded,
    toggle,
    requestCreate,
    requestUpload,
    requestRename,
    requestDelete,
  }

  return (
    <ExplorerContext.Provider value={ctx}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex-1 min-h-0 overflow-auto py-1 text-sm">
            <DirectoryChildren path="" depth={0} />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-44">
          <ContextMenuItem onSelect={() => requestCreate("", false)}>
            <FilePlus className="mr-2 h-4 w-4" />
            New file
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => requestCreate("", true)}>
            <FolderPlus className="mr-2 h-4 w-4" />
            New folder
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => requestUpload("")}>
            <UploadSimple className="mr-2 h-4 w-4" />
            Upload files
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Shared native picker for every "Upload files" action. */}
      <input
        ref={uploadInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length) {
            uploadMut.mutate({ parentPath: uploadTarget.current, files })
          }
        }}
      />

      <NameDialog
        pending={pending}
        onOpenChange={(open) => !open && setPending(null)}
        onSubmit={submitName}
      />

      <DeleteDialog
        entry={toDelete}
        pending={deleteMut.isPending}
        onOpenChange={(open) => !open && setToDelete(null)}
        onConfirm={() => {
          if (toDelete) deleteMut.mutate(toDelete.path)
          setToDelete(null)
        }}
      />
    </ExplorerContext.Provider>
  )
}

interface ChildrenProps {
  path: string
  depth: number
}

function DirectoryChildren({ path, depth }: ChildrenProps) {
  const { workspaceId } = useExplorer()
  const { data, isLoading, isError } = useDirectory(workspaceId, path)

  if (isLoading) {
    return <LoadingRows depth={depth} />
  }
  if (isError) {
    return <Hint depth={depth}>Couldn’t load this folder.</Hint>
  }
  if (!data || data.length === 0) {
    return depth === 0 ? <Hint depth={depth}>This folder is empty.</Hint> : null
  }

  // Directories first, then files — each group alphabetical. A stable order
  // keeps the tree from reshuffling as the watcher streams changes in.
  const sorted = [...data].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  // The skills catalog is a flat directory of folders from several different
  // places — most of them symlinks into ~/.claude or ~/.hermes — and which one a
  // skill came from decides what editing it affects. The server labels those rows;
  // grouping under that label answers it once per group instead of spending width
  // on every row, which a ~160px tree does not have.
  const groups = groupBySource(sorted)
  if (groups) {
    return (
      <>
        {groups.map(([label, entries]) => (
          <div key={label}>
            <SourceHeading label={label} count={entries.length} depth={depth} />
            {entries.map((entry) => (
              <TreeNode key={entry.path} entry={entry} depth={depth} />
            ))}
          </div>
        ))}
      </>
    )
  }

  return (
    <>
      {sorted.map((entry) => (
        <TreeNode key={entry.path} entry={entry} depth={depth} />
      ))}
    </>
  )
}

/**
 * Bucket a listing by `source_label`, or null when there is nothing to group.
 *
 * Null is the answer for every ordinary directory — one bucket, or none labelled —
 * so the plain tree is what an ordinary workspace still renders. Ours sorts first:
 * they are the ones you wrote and the ones you come here to edit, and on a machine
 * that has used Claude Code for a while they would otherwise sit below twenty rows
 * of somebody else's.
 */
function groupBySource(entries: DirEntry[]): [string, DirEntry[]][] | null {
  if (!entries.some((entry) => entry.source_label)) return null
  const buckets = new Map<string, DirEntry[]>()
  for (const entry of entries) {
    const key = entry.source_label || OTHER_SOURCE
    const bucket = buckets.get(key)
    if (bucket) bucket.push(entry)
    else buckets.set(key, [entry])
  }
  if (buckets.size < 2) return null
  return [...buckets].sort(([a], [b]) => rankSource(a) - rankSource(b) || a.localeCompare(b))
}

/** Ours first, then the borrowed sources alphabetically, then the leftovers. */
function rankSource(label: string): number {
  if (label === OWN_SOURCE) return 0
  if (label === OTHER_SOURCE) return 2
  return 1
}

/** Matches `OWN_SOURCE_LABEL` in the files API — a skill that really lives here. */
const OWN_SOURCE = "Lursor"

/** Bucket for rows the server had nothing to say about (loose files, say). */
const OTHER_SOURCE = "Other"

function SourceHeading({
  label,
  count,
  depth,
}: {
  label: string
  count: number
  depth: number
}) {
  return (
    <div
      style={{ paddingLeft: BASE_INDENT + depth * INDENT_STEP }}
      className="flex items-center gap-1.5 pr-2 pt-2 pb-0.5"
    >
      {/* Not uppercased, unlike the section headings elsewhere: most of these are
          real directory paths and "~/.CLAUDE" is not one. */}
      <span
        className="min-w-0 truncate text-[10px] font-medium tracking-wide text-muted-foreground"
        title={label === OWN_SOURCE ? "Skills stored in your Lursor catalog" : label}
      >
        {label}
      </span>
      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
        {count}
      </span>
      <span className="ml-1 h-px min-w-2 flex-1 bg-border/60" />
    </div>
  )
}

interface TreeNodeProps {
  entry: DirEntry
  depth: number
}

function TreeNode({ entry, depth }: TreeNodeProps) {
  const {
    workspaceId,
    activePath,
    onOpenFile,
    isExpanded,
    toggle,
    requestCreate,
    requestUpload,
    requestRename,
    requestDelete,
  } = useExplorer()
  // Open state is tracked so the skill scan only runs for a folder someone has
  // actually right-clicked, not for every row in the tree.
  const [menuOpen, setMenuOpen] = useState(false)
  const expanded = entry.is_dir && isExpanded(entry.path)
  const isActive = !entry.is_dir && entry.path === activePath
  const { Icon: FileGlyph } = fileKind(entry.name)
  const paddingLeft = BASE_INDENT + depth * INDENT_STEP
  // New items land inside a folder, or alongside a file (in its parent).
  const createParent = entry.is_dir ? entry.path : parentOf(entry.path)
  // A linked entry is a pointer into another tool's directory. Editing under it
  // writes there, so the row says whose it is rather than looking like every other
  // folder — and the tooltip carries the path the badge has no room for.
  const linked = Boolean(entry.link_target)
  const rowTitle = linked
    ? `${entry.name} — linked from ${entry.link_target}`
    : entry.name

  return (
    <div>
      <ContextMenu onOpenChange={setMenuOpen}>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={() =>
              entry.is_dir ? toggle(entry.path) : onOpenFile(entry.path, entry.name)
            }
            style={{ paddingLeft }}
            aria-expanded={entry.is_dir ? expanded : undefined}
            title={rowTitle}
            className={cn(
              "group relative flex w-full items-center gap-1.5 py-1 pr-2 text-left outline-none",
              "focus-visible:bg-accent/60 focus-visible:text-foreground",
              isActive
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            )}
          >
            {/* Active rail — the shared "you are here" marker. */}
            {isActive && (
              <span className="absolute inset-y-0 left-0 w-0.5 bg-primary" />
            )}

            {entry.is_dir ? (
              <>
                <CaretRight
                  className={cn(
                    "h-3.5 w-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 motion-reduce:transition-none",
                    expanded && "rotate-90"
                  )}
                />
                {/* A link gets its own glyph, so the rows are separable at a
                    glance before you read a single label. */}
                {linked ? (
                  <FolderSimpleDashed className="h-3.5 w-3.5 shrink-0" />
                ) : expanded ? (
                  <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <Folder className="h-3.5 w-3.5 shrink-0" />
                )}
              </>
            ) : (
              <FileGlyph
                className={cn(
                  "ml-[1.125rem] h-3.5 w-3.5 shrink-0",
                  isActive ? "text-foreground" : "text-muted-foreground/80"
                )}
              />
            )}
            {/* The name gets the width. The source is on the group heading above,
                which costs one row instead of a slice of every row — in a tree
                this narrow a badge here truncated names to a single letter. */}
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-44">
          <ContextMenuItem onSelect={() => requestCreate(createParent, false)}>
            <FilePlus className="mr-2 h-4 w-4" />
            New file
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => requestCreate(createParent, true)}>
            <FolderPlus className="mr-2 h-4 w-4" />
            New folder
          </ContextMenuItem>
          {entry.is_dir && (
            <ContextMenuItem onSelect={() => requestUpload(entry.path)}>
              <UploadSimple className="mr-2 h-4 w-4" />
              Upload files
            </ContextMenuItem>
          )}
          {/* Only for folders, and only when one actually holds a SKILL.md. */}
          {entry.is_dir && (
            <SkillIngestMenu
              workspaceId={workspaceId}
              path={entry.path}
              open={menuOpen}
            />
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => requestRename(entry)}>
            <Pencil className="mr-2 h-4 w-4" />
            Rename
          </ContextMenuItem>
          <ContextMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={() => requestDelete(entry)}
          >
            <Trash className="mr-2 h-4 w-4" />
            Delete
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {entry.is_dir && expanded && (
        <DirectoryChildren path={entry.path} depth={depth + 1} />
      )}
    </div>
  )
}

interface NameDialogProps {
  pending: Pending | null
  onOpenChange: (open: boolean) => void
  onSubmit: (name: string) => void
}

/** Collects a name for a create/rename operation. */
function NameDialog({ pending, onOpenChange, onSubmit }: NameDialogProps) {
  const [value, setValue] = useState("")

  // Seed the input each time a fresh operation opens the dialog: rename starts
  // from the existing name, create from empty.
  useEffect(() => {
    if (pending?.mode === "rename") setValue(pending.entry.name)
    else if (pending?.mode === "create") setValue("")
  }, [pending])

  const { title, description, submitLabel } = dialogCopy(pending)

  return (
    <Dialog open={pending !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            onSubmit(value)
          }}
        >
          <Input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Name"
            aria-label="Name"
          />
          <DialogFooter className="mt-4">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit">{submitLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function dialogCopy(pending: Pending | null): {
  title: string
  description: string
  submitLabel: string
} {
  if (pending?.mode === "rename") {
    return {
      title: "Rename",
      description: `Rename “${pending.entry.name}”.`,
      submitLabel: "Rename",
    }
  }
  const isDir = pending?.mode === "create" && pending.isDir
  const where =
    pending?.mode === "create" && pending.parentPath
      ? ` in ${pending.parentPath}`
      : ""
  return {
    title: isDir ? "New folder" : "New file",
    description: `Create a new ${isDir ? "folder" : "file"}${where}.`,
    submitLabel: "Create",
  }
}

interface DeleteDialogProps {
  entry: DirEntry | null
  pending: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

function DeleteDialog({ entry, pending, onOpenChange, onConfirm }: DeleteDialogProps) {
  return (
    <Dialog open={entry !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {entry?.is_dir ? "folder" : "file"}</DialogTitle>
          <DialogDescription>
            {entry?.is_dir
              ? `Delete “${entry?.name}” and everything inside it? This can’t be undone.`
              : `Delete “${entry?.name}”? This can’t be undone.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={onConfirm}
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function errMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message
  return err instanceof Error ? err.message : fallback
}

/** Skeleton rows shown while a directory loads, indented to match the tree. */
function LoadingRows({ depth }: { depth: number }) {
  const widths = ["60%", "45%", "72%"]
  return (
    <div className="space-y-1.5 py-1">
      {widths.map((w, i) => (
        <div
          key={i}
          className="flex items-center gap-1.5 pr-2"
          style={{ paddingLeft: BASE_INDENT + depth * INDENT_STEP }}
        >
          <Skeleton className="h-3.5 w-3.5 rounded-sm" />
          <Skeleton className="h-3" style={{ width: w }} />
        </div>
      ))}
    </div>
  )
}

function Hint({ depth, children }: { depth: number; children: React.ReactNode }) {
  return (
    <p
      className="py-1 pr-2 text-xs text-muted-foreground"
      style={{ paddingLeft: BASE_INDENT + depth * INDENT_STEP }}
    >
      {children}
    </p>
  )
}
