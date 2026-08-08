import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  CaretRight,
  Copy,
  Folder,
  FolderOpen,
  FolderSimpleDashed,
  FilePlus,
  FolderPlus,
  Globe,
  Pencil,
  Trash,
  UploadSimple,
} from "@phosphor-icons/react"
import { toast } from "sonner"

import { filesApi, useDirectory } from "@/api/files"
import type { DirEntry, UploadEntry } from "@/api/files"
import { gitKeys, useGitStatus } from "@/api/git"
import { useWorkspace } from "@/api/workspaces"
import { ApiError } from "@/api/client"
import { LOADING_DELAY_MS, useDelayed } from "@/hooks/use-delayed"
import { useFileWatch } from "@/hooks/use-file-watch"
import { useGitWatch } from "@/hooks/use-git-watch"
import {
  buildGitStatusIndex,
  type GitDecoration,
  type GitStatusIndex,
} from "@/lib/git-tree-status"
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
import { startFileDragOut, takeOutgoingDrag } from "@/lib/file-drag-out"
import {
  collectDroppedFiles,
  droppedPaths,
  hasFiles,
  hasTreeItem,
  readTreeItem,
} from "@/lib/file-drop-in"
import { requestOpenPreview } from "@/lib/open-preview"
import { cn, copyToClipboard } from "@/lib/utils"

import { fileKind } from "./file-icon"
import { SkillIngestMenu } from "./skill-ingest-menu"

/** Left indent per tree level; row text starts one step in from the panel edge. */
const INDENT_STEP = 12
const BASE_INDENT = 8

/**
 * How a git state reads on a row: VS Code's letter and colour vocabulary, spelled
 * in this theme's semantic tokens (amber for an edit, green for something new, red
 * for a loss or a conflict, and a fade for what git is not tracking).
 *
 * Folders show a dot in the same colour instead of a letter — the rollup says
 * *something* below changed, not which letter to expect.
 */
const GIT_DECOR: Record<
  GitDecoration,
  { letter: string; label: string; className: string }
> = {
  modified: { letter: "M", label: "Modified", className: "text-warning" },
  added: { letter: "A", label: "Added", className: "text-success" },
  untracked: { letter: "U", label: "Untracked", className: "text-success" },
  deleted: { letter: "D", label: "Deleted", className: "text-destructive" },
  conflicted: { letter: "C", label: "Conflicted", className: "text-destructive" },
  // No letter: an ignored row is stated by the fade alone, exactly as in VS Code —
  // a badge on every generated file would out-shout the changes that matter.
  ignored: { letter: "", label: "Ignored", className: "text-muted-foreground/50" },
}

/**
 * Coalesce bursts of edits into a single git re-query. An agent can touch dozens
 * of files a second, and each refresh is a `git status` per repo under the
 * workspace — matching the Changes panel's window keeps the tree live for the
 * price of two queries a second at worst.
 */
const GIT_REFRESH_DEBOUNCE_MS = 500

/** The parent directory of a workspace-relative path ("" for a root-level item). */
function parentOf(path: string): string {
  const i = path.lastIndexOf("/")
  return i === -1 ? "" : path.slice(0, i)
}

/** Join a parent dir and a name into a workspace-relative path. */
function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

/**
 * The on-disk path of a workspace-relative one, given the workspace root.
 *
 * Tree paths are POSIX-style whatever the host is, and the root arrives verbatim
 * from the server, so the only normalising needed is the trailing slash a root
 * may or may not carry.
 */
function absolutePath(root: string, path: string): string {
  const base = root.replace(/\/+$/, "")
  return path ? `${base}/${path}` : base
}

/** A page the preview panel can render as a page rather than as source text. */
function isHtmlFile(name: string): boolean {
  return /\.x?html?$/i.test(name)
}

/**
 * The folder a drop on `target` lands in.
 *
 * A folder row takes the drop itself; a file row passes it to the folder it lives in
 * (dropping *onto* a file has no meaning, and refusing the drop would just make the
 * gaps between folders dead). Anything else is the empty area, which stands for the
 * workspace root here exactly as it does for the root context menu.
 */
function dropDestination(target: EventTarget | null): string {
  const row = target instanceof Element ? target.closest("[data-tree-path]") : null
  if (!row) return ""
  const path = row.getAttribute("data-tree-path") ?? ""
  return row.getAttribute("data-tree-dir") === "true" ? path : parentOf(path)
}

/**
 * The dropped paths as workspace-relative ones, or null if this isn't a drop of
 * files that already live in the workspace.
 *
 * All or nothing on purpose: a mixed drop of inside and outside files has no single
 * answer — half a move and half an upload is not a thing anyone dragged for — so it
 * is treated as the upload it mostly is.
 */
function insideWorkspace(root: string, paths: string[]): string[] | null {
  if (!root || paths.length === 0) return null
  const base = `${root.replace(/\/+$/, "")}/`
  const relative: string[] = []
  for (const absolute of paths) {
    if (!absolute.startsWith(base)) return null
    const rel = absolute.slice(base.length)
    if (!rel) return null
    relative.push(rel)
  }
  return relative
}

/**
 * What stands in the way of moving `item` into `dest`: a message to show, the
 * sentinel `"already"` for a row dropped back where it started, or null to go ahead.
 */
function moveBlocker(item: { path: string; isDir: boolean }, dest: string): string | null {
  if (parentOf(item.path) === dest) return "already"
  // Moving a folder inside itself would move the destination along with it.
  if (item.isDir && (dest === item.path || dest.startsWith(`${item.path}/`))) {
    return "A folder can’t be moved inside itself."
  }
  return null
}

/** An upload waiting on an answer about the names it would overwrite. */
interface PendingUpload {
  /** Destination folder, "" for the workspace root. */
  destPath: string
  items: UploadEntry[]
  /** Existing names in the destination the drop would write over. */
  clashes: string[]
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
  /** Put a row's absolute on-disk path on the clipboard. */
  copyPath: (path: string) => Promise<void>
  /**
   * The workspace's root on the backend host, or "" until it has loaded. Rows need
   * it to name themselves absolutely — for the clipboard, and for a drag out of the
   * window (see {@link startFileDragOut}).
   */
  workspaceRoot: string
  /**
   * The folder a drag is hovering ("" for the root), or null when nothing is being
   * dragged. Rows read it to draw the drop highlight; the drop itself is handled once
   * for the whole tree.
   */
  dropTarget: string | null
  /** Git state per row; every row is clean outside a repo. */
  gitStatus: GitStatusIndex
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
 * context menu to create, rename, delete or copy the path of files and folders —
 * and, on a folder holding a `SKILL.md`, to ingest it as a skill (see
 * {@link SkillIngestMenu}).
 * Depth is drawn with hairline indent guides, and the active file carries a left
 * accent rail.
 *
 * Rows carry their git state the way VS Code's explorer does — a coloured name
 * plus a letter, with changes rolled up onto the collapsed folders above them —
 * fed by the workspace's `/git/status` and kept live by the same two sockets the
 * Changes panel listens to.
 */
export function FileExplorer({
  workspaceId,
  activePath,
  onOpenFile,
}: FileExplorerProps) {
  const qc = useQueryClient()
  // Only for "Copy path" — the workspace root the tree's relative paths hang
  // off. Already cached by whatever opened this workspace.
  const { data: workspace } = useWorkspace(workspaceId)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<Pending | null>(null)
  const [toDelete, setToDelete] = useState<DirEntry | null>(null)
  // Hidden native picker, reused for every upload; its target folder is stashed
  // in a ref between the menu click and the resulting `change` event.
  const uploadInputRef = useRef<HTMLInputElement>(null)
  const uploadTarget = useRef<string>("")
  // The folder a drag is currently over ("" for the root), or null when nothing is
  // being dragged across the panel. Drives the drop highlight.
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [pendingUpload, setPendingUpload] = useState<PendingUpload | null>(null)

  const invalidateTree = useCallback(
    () => qc.invalidateQueries({ queryKey: ["files", workspaceId, "dir"] }),
    [qc, workspaceId]
  )

  // Git decorations. Two sockets keep them honest, as in the Changes panel: the
  // files watcher for working-tree edits, and the git watcher for the transitions
  // it can't see because it ignores `.git/` — a commit, a `git add`, a branch
  // switch. Both funnel through one debounce, so a burst of edits followed by a
  // commit re-queries git once.
  const { data: gitData } = useGitStatus(workspaceId)
  const gitStatus = useMemo(() => buildGitStatusIndex(gitData), [gitData])
  const gitRefreshRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const scheduleGitRefresh = useCallback(() => {
    clearTimeout(gitRefreshRef.current)
    gitRefreshRef.current = setTimeout(() => {
      qc.invalidateQueries({ queryKey: gitKeys.status(workspaceId) })
    }, GIT_REFRESH_DEBOUNCE_MS)
  }, [qc, workspaceId])
  useFileWatch(workspaceId, scheduleGitRefresh)
  useGitWatch(workspaceId, scheduleGitRefresh)
  useEffect(() => () => clearTimeout(gitRefreshRef.current), [])

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

  const workspaceRoot = workspace?.path ?? ""
  const copyPath = useCallback(
    async (path: string) => {
      // Without the root there is no absolute path to give, and half of one
      // pasted into a terminal is worse than a refusal.
      if (!workspaceRoot) {
        toast.error("Couldn’t resolve the workspace path")
        return
      }
      if (await copyToClipboard(absolutePath(workspaceRoot, path))) {
        toast.success("Copied path")
      } else {
        toast.error("Couldn’t copy path")
      }
    },
    [workspaceRoot]
  )

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
    mutationFn: ({ parentPath, items }: { parentPath: string; items: UploadEntry[] }) =>
      filesApi.upload(workspaceId, parentPath, items),
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
    // Expanding the destination matters for a move, and costs nothing for a rename
    // in place — a row you could rename was in an expanded folder already.
    onSuccess: (entry) => {
      void invalidateTree()
      expand(parentOf(entry.path))
    },
    onError: (err) => toast.error(errMessage(err, "Could not move or rename")),
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

  /**
   * Upload `items` into `destPath`, asking first about anything they'd write over.
   *
   * The upload endpoint overwrites by name without comment, which is the right
   * behaviour for a deliberate "Upload files" but a bad one for a drop: a row
   * missed by a few pixels shouldn't silently replace a file. So the destination is
   * listed first and any collision becomes a question. A listing that fails is *not*
   * treated as a collision — the server is the authority on what it holds, and
   * refusing the drop because a pre-check broke would be a worse answer than the
   * upload's own.
   */
  const startUpload = useCallback(
    async (destPath: string, items: UploadEntry[]) => {
      if (items.length === 0) return
      // Only the first segment can collide: deeper names live inside a folder this
      // drop is creating or merging into.
      const incoming = new Set(
        items.map((item) => (item.path || item.file.name).split("/")[0])
      )
      let clashes: string[] = []
      try {
        const existing = await filesApi.list(workspaceId, destPath)
        clashes = existing.filter((e) => incoming.has(e.name)).map((e) => e.name)
      } catch {
        /* Nothing known to overwrite; let the upload be the answer. */
      }
      if (clashes.length > 0) {
        setPendingUpload({ destPath, items, clashes })
        return
      }
      uploadMut.mutate({ parentPath: destPath, items })
    },
    [workspaceId, uploadMut]
  )

  /**
   * Move a row into `destPath` — a drop that started inside the tree, or one whose
   * files were already in this workspace to begin with.
   *
   * A move rather than a copy because the file is the *same* file: uploading it back
   * into a folder next door would leave two of it, which is not what dragging a row
   * onto a folder has ever meant. Rename refuses to overwrite (409), so a name
   * already taken in the destination surfaces as an error instead of a loss.
   */
  const moveInto = useCallback(
    (items: { path: string; name: string; isDir: boolean }[], destPath: string) => {
      for (const item of items) {
        const blocker = moveBlocker(item, destPath)
        // "already" is the common near-miss — dropping a row back on its own folder.
        // Nothing to do and nothing worth saying.
        if (blocker === "already") continue
        if (blocker) {
          toast.error(blocker)
          continue
        }
        renameMut.mutate({
          path: item.path,
          newPath: joinPath(destPath, item.name),
        })
      }
    },
    [renameMut]
  )

  /**
   * Take a drop on the tree: a row from inside it, files that already live in the
   * workspace, or files from outside.
   *
   * Order matters, and so does doing the synchronous reads first: `dataTransfer`'s
   * item list dies with the event, so the entry walk has to be *started* here even
   * though it finishes later.
   */
  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      const destPath = dropDestination(event.target)
      setDropTarget(null)
      const data = event.dataTransfer

      // A row of ours, by either of the two ways one can identify itself: the marker
      // a browser drag carries, or — for a desktop drag, which has no marker because
      // it cancelled its own HTML drag — the record of what this window just started
      // dragging, matched against what arrived.
      const names = hasFiles(data) ? Array.from(data.files).map((f) => f.name) : []
      const dragged = readTreeItem(data) ?? (names.length ? takeOutgoingDrag(names) : null)
      if (dragged) {
        event.preventDefault()
        // Two explorers can be open on two workspaces. A row dragged between them
        // isn't a move — there is no path from one root to the other — and silence
        // would read as a bug rather than as a refusal.
        if (dragged.workspaceId !== workspaceId) {
          toast.error("A file can only be moved within its own workspace.")
          return
        }
        moveInto([dragged], destPath)
        return
      }

      if (names.length === 0) return
      event.preventDefault()

      const internal = insideWorkspace(workspaceRoot, droppedPaths(data))
      if (internal) {
        moveInto(
          internal.map((rel) => ({
            path: rel,
            name: rel.slice(rel.lastIndexOf("/") + 1),
            // A path alone doesn't say which it is, so assume the case with a rule:
            // only a folder can swallow its own destination. Harmless for a file,
            // whose path can never be a prefix of a real folder's.
            isDir: true,
          })),
          destPath
        )
        return
      }

      const collecting = collectDroppedFiles(data)
      void collecting.then(({ items, error }) => {
        if (error) {
          toast.error(error)
          return
        }
        void startUpload(destPath, items)
      })
    },
    [workspaceId, workspaceRoot, moveInto, startUpload]
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
    copyPath,
    workspaceRoot,
    dropTarget,
    gitStatus,
  }

  return (
    <ExplorerContext.Provider value={ctx}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          {/* One drop surface for the whole tree, rather than a handler per row:
              dragover bubbles, so the row under the cursor is a `closest` away, and
              the empty space below the last row stays a target for the root instead
              of a dead strip. */}
          <div
            className={cn(
              "flex-1 min-h-0 overflow-auto py-1 text-sm",
              // The root's own highlight — an inset ring, so it can't be mistaken
              // for a row's fill.
              dropTarget === "" && "ring-1 ring-inset ring-primary/40 bg-accent/20"
            )}
            onDragOver={(event) => {
              const data = event.dataTransfer
              const ours = hasTreeItem(data)
              if (!ours && !hasFiles(data)) return
              // Without this the browser refuses the drop and falls back to opening
              // the file it was handed.
              event.preventDefault()
              data.dropEffect = ours ? "move" : "copy"
              setDropTarget(dropDestination(event.target))
            }}
            onDragLeave={(event) => {
              // dragleave fires on every child crossed on the way in, so only a
              // departure from the panel itself clears the highlight.
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
                return
              }
              setDropTarget(null)
            }}
            onDrop={handleDrop}
          >
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
          <ContextMenuSeparator />
          {/* The empty area stands for the root, so the path it gives is the
              workspace's own. */}
          <ContextMenuItem onSelect={() => void copyPath("")}>
            <Copy className="mr-2 h-4 w-4" />
            Copy workspace path
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
          // Same route as a drop, so a picked file that would overwrite something
          // asks the same question a dropped one does.
          if (files.length) {
            void startUpload(
              uploadTarget.current,
              files.map((file) => ({ file }))
            )
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

      <OverwriteDialog
        upload={pendingUpload}
        onOpenChange={(open) => !open && setPendingUpload(null)}
        onConfirm={() => {
          if (pendingUpload) {
            uploadMut.mutate({
              parentPath: pendingUpload.destPath,
              items: pendingUpload.items,
            })
          }
          setPendingUpload(null)
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
  const showLoading = useDelayed(isLoading, LOADING_DELAY_MS)

  if (isLoading) {
    // Nothing at all for the first moments — see LOADING_DELAY_MS.
    return showLoading ? <LoadingRows depth={depth} /> : null
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
    copyPath,
    workspaceRoot,
    dropTarget,
    gitStatus,
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
  const decoration = gitStatus.forPath(entry.path, entry.is_dir)
  const git = decoration ? GIT_DECOR[decoration] : null
  // Only a folder can *be* a destination: a drag over a file targets the folder it
  // sits in, and highlighting the file would point at the wrong row.
  const isDropTarget = entry.is_dir && dropTarget === entry.path
  // One tooltip, assembled from whatever this row has to say — the name always,
  // then where a link points and what git makes of it.
  const rowTitle = [
    entry.name,
    linked ? `linked from ${entry.link_target}` : null,
    git?.label,
  ]
    .filter(Boolean)
    .join(" — ")

  return (
    <div>
      <ContextMenu onOpenChange={setMenuOpen}>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={() =>
              entry.is_dir ? toggle(entry.path) : onOpenFile(entry.path, entry.name)
            }
            // Rows leave the window as real files: in the desktop app the drag is
            // handed to the main process, in a browser it goes out as a download
            // promise plus the path as text. Nothing in the tree reorders, so a row
            // being draggable can only mean "out".
            draggable
            onDragStart={(event) =>
              startFileDragOut(event, {
                workspaceId,
                path: entry.path,
                name: entry.name,
                isDir: entry.is_dir,
                absPath: workspaceRoot ? absolutePath(workspaceRoot, entry.path) : "",
              })
            }
            // Read back by the tree's one drop handler to find the folder under the
            // cursor. On the row itself rather than in React state because a
            // `dragover` has no other way to ask which row it is over.
            data-tree-path={entry.path}
            data-tree-dir={entry.is_dir}
            style={{ paddingLeft }}
            aria-expanded={entry.is_dir ? expanded : undefined}
            title={rowTitle}
            className={cn(
              "group relative flex w-full items-center gap-1.5 py-1 pr-2 text-left outline-none",
              "focus-visible:bg-accent/60 focus-visible:text-foreground",
              isActive
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              // Where a drop would land. Beats the active row's fill on purpose:
              // during a drag the only question is where this is going.
              isDropTarget && "bg-primary/15 text-foreground ring-1 ring-inset ring-primary/50"
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
            <span className={cn("min-w-0 flex-1 truncate", git?.className)}>
              {entry.name}
            </span>

            {/* Git marker, right-aligned after the name: a letter for a file, a
                dot for a folder standing in for the changes it holds. Ignored rows
                carry no letter, so both branches skip them. */}
            {git?.letter &&
              (entry.is_dir ? (
                <span
                  aria-hidden
                  className={cn(
                    "mr-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-current",
                    git.className
                  )}
                />
              ) : (
                <span
                  className={cn(
                    "shrink-0 text-[10px] font-semibold leading-none",
                    git.className
                  )}
                >
                  {git.letter}
                </span>
              ))}
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-44">
          {/* An HTML file is worth looking at rendered, not just as source, so it
              gets the top slot — the reason you right-clicked it. */}
          {!entry.is_dir && isHtmlFile(entry.name) && (
            <>
              <ContextMenuItem
                onSelect={() =>
                  requestOpenPreview({
                    workspaceId,
                    url: filesApi.serveUrl(workspaceId, entry.path),
                  })
                }
              >
                <Globe className="mr-2 h-4 w-4" />
                Open in Preview
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
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
          <ContextMenuItem onSelect={() => void copyPath(entry.path)}>
            <Copy className="mr-2 h-4 w-4" />
            Copy path
          </ContextMenuItem>
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

interface OverwriteDialogProps {
  upload: PendingUpload | null
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

/**
 * The question a drop asks before it writes over something.
 *
 * Names, not a count: "replace 3 files" is unanswerable without knowing which
 * three, and the whole point of the dialog is that a drop can land somewhere the
 * user didn't mean.
 */
function OverwriteDialog({ upload, onOpenChange, onConfirm }: OverwriteDialogProps) {
  const clashes = upload?.clashes ?? []
  const shown = clashes.slice(0, MAX_LISTED_CLASHES)
  const rest = clashes.length - shown.length
  const where = upload?.destPath ? `“${upload.destPath}”` : "the workspace root"

  return (
    <Dialog open={upload !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Replace {clashes.length === 1 ? "an item" : `${clashes.length} items`}?
          </DialogTitle>
          <DialogDescription>
            {where} already has {shown.map((name) => `“${name}”`).join(", ")}
            {rest > 0 ? ` and ${rest} more` : ""}. Dropping here overwrites{" "}
            {clashes.length === 1 ? "it" : "them"}, and that can’t be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={onConfirm}>
            Replace
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Past this many, the list stops being readable and a count says it better. */
const MAX_LISTED_CLASHES = 5

function errMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message
  return err instanceof Error ? err.message : fallback
}

/** Skeleton rows shown while a directory loads, indented to match the tree. */
function LoadingRows({ depth }: { depth: number }) {
  const widths = ["60%", "45%", "72%"]
  return (
    <div>
      {widths.map((w, i) => (
        // Row geometry matches TreeNode's, so the real rows replace these in place.
        <div
          key={i}
          className="flex items-center gap-1.5 py-1 pr-2"
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
