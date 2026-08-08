/**
 * Reading a drop *into* the app: what the OS handed us, and what one of our own
 * rows handed us.
 *
 * The counterpart to {@link ./file-drag-out}. Everything here is about a
 * `DataTransfer`, which is a hostile little object: its `items` list is only alive
 * during the event that delivered it, `getData` is unreadable while a drag is still
 * in flight, and a dropped folder arrives as an *entry* rather than as files. So
 * each of these functions is explicit about when it may be called.
 */

import type { UploadEntry } from "@/api/files"

/**
 * Drag payload an explorer row sets on itself, so a drop inside the tree can be
 * told from one arriving off the desktop. A custom MIME type for the same reason
 * `editor-pane.tsx` uses one for tabs: `dragover` has to decide whether a drag is
 * ours without being allowed to read it, and the type list is all it gets.
 *
 * Absent on a desktop drag-out, which cancels the HTML drag entirely — there the
 * dropped file's real path is what identifies it. See {@link droppedPaths}.
 */
export const TREE_ITEM_DRAG_TYPE = "application/x-lursor-tree-item"

export interface TreeDragPayload {
  workspaceId: string
  /** POSIX path relative to the workspace root. */
  path: string
  name: string
  isDir: boolean
}

/** Whether a drag *claims* to carry one of our rows. Safe during `dragover`. */
export function hasTreeItem(data: DataTransfer): boolean {
  return data.types.includes(TREE_ITEM_DRAG_TYPE)
}

/** Whether a drag carries files from outside. Safe during `dragover`. */
export function hasFiles(data: DataTransfer): boolean {
  return data.types.includes("Files")
}

/** The row a drag started from, or null if this drag isn't one of ours. */
export function readTreeItem(data: DataTransfer): TreeDragPayload | null {
  const raw = data.getData(TREE_ITEM_DRAG_TYPE)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return null
    const item = parsed as Partial<TreeDragPayload>
    if (typeof item.workspaceId !== "string" || typeof item.path !== "string") return null
    if (typeof item.name !== "string") return null
    return {
      workspaceId: item.workspaceId,
      path: item.path,
      name: item.name,
      isDir: Boolean(item.isDir),
    }
  } catch {
    return null
  }
}

/**
 * On-disk paths of the dropped files, in the desktop app.
 *
 * Empty in a browser, which never reveals a path — and empty for a drag that
 * carries no files. This is what makes a drop *identifiable*: a file already inside
 * the workspace is the same file, not a copy of it, so dropping it on another folder
 * can move it rather than uploading a duplicate of something already on that disk.
 *
 * **Also empty on a remote connection**, where these are paths on *this* machine and
 * the workspace is on another. A machine that happens to have the same layout as the
 * backend would otherwise turn a perfectly ordinary upload into a move of a file
 * over there — the same trap the drag-out path avoids by not trusting a path it
 * didn't resolve locally.
 *
 * Must be called during the drop event, before any `await`.
 */
export function droppedPaths(data: DataTransfer): string[] {
  const bridge = typeof window !== "undefined" ? window.electron : undefined
  if (!bridge?.filePath || bridge.isRemote) return []
  const paths: string[] = []
  for (const file of Array.from(data.files)) {
    const resolved = bridge.filePath(file)
    if (resolved) paths.push(resolved)
  }
  return paths
}

/** Ceilings on one drop. The upload is a single request, so both are real limits. */
const MAX_DROP_FILES = 300
const MAX_DROP_BYTES = 128 * 1024 * 1024

export interface CollectedDrop {
  /**
   * The dropped files, each carrying its path relative to the drop — so a dropped
   * folder keeps its shape rather than flattening into the destination.
   */
  items: UploadEntry[]
  /** Set when a cap was hit; nothing is uploaded, because a partial drop is a lie. */
  error?: string
}

/**
 * Everything a drop is offering, folders walked out into their files.
 *
 * `items` is only alive during the event, so every entry is claimed synchronously
 * up front and only then walked — an `await` before `webkitGetAsEntry` and the list
 * is already empty. Falls back to `files` when entries aren't available (older
 * browsers, and any drag with no directories in it).
 */
export async function collectDroppedFiles(data: DataTransfer): Promise<CollectedDrop> {
  const entries: FileSystemEntry[] = []
  for (const item of Array.from(data.items)) {
    if (item.kind !== "file") continue
    const entry = item.webkitGetAsEntry?.()
    if (entry) entries.push(entry)
  }

  if (entries.length === 0) {
    return capped(Array.from(data.files).map((file) => ({ file })))
  }

  const items: UploadEntry[] = []
  for (const entry of entries) {
    const failure = await walkEntry(entry, "", items)
    if (failure) return { items: [], error: failure }
  }
  return capped(items)
}

/** Reject an over-sized drop as a whole rather than uploading part of it. */
function capped(items: UploadEntry[]): CollectedDrop {
  if (items.length > MAX_DROP_FILES) {
    return {
      items: [],
      error: `That's ${items.length} files — drop ${MAX_DROP_FILES} or fewer at a time.`,
    }
  }
  const bytes = items.reduce((total, item) => total + item.file.size, 0)
  if (bytes > MAX_DROP_BYTES) {
    return {
      items: [],
      error: `That's ${Math.round(bytes / 1024 / 1024)} MB — drop ${Math.round(
        MAX_DROP_BYTES / 1024 / 1024
      )} MB or less at a time.`,
    }
  }
  return { items }
}

/**
 * Add `entry` to `items`, recursing into a directory. Resolves to an error message
 * if the walk hit a cap, so a folder with a million files gives up early instead of
 * filling memory before anyone checks.
 */
async function walkEntry(
  entry: FileSystemEntry,
  prefix: string,
  items: UploadEntry[]
): Promise<string | null> {
  if (items.length > MAX_DROP_FILES) {
    return `That folder holds more than ${MAX_DROP_FILES} files — too many for one drop.`
  }

  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) => {
      ;(entry as FileSystemFileEntry).file(resolve, () => resolve(null))
    })
    // A file that won't open is skipped rather than failing the drop: a locked
    // .DS_Store shouldn't cost someone the folder they dragged in.
    if (!file) return null
    // The path travels beside the file, not inside it: `webkitRelativePath` is
    // read-only and empty on an entry-walked file, and re-wrapping the File to put
    // the path in its name is not dependable (see {@link UploadEntry}).
    items.push({ file, path: `${prefix}${file.name}` })
    return null
  }

  if (!entry.isDirectory) return null

  const reader = (entry as FileSystemDirectoryEntry).createReader()
  const children = await readAllEntries(reader)
  for (const child of children) {
    const failure = await walkEntry(child, `${prefix}${entry.name}/`, items)
    if (failure) return failure
  }
  return null
}

/**
 * Every child of a directory entry.
 *
 * `readEntries` hands back a batch at a time (100 in Chromium) and signals the end
 * with an empty one, so a single call silently truncates any directory larger than
 * that — the trap this function exists to close.
 */
async function readAllEntries(
  reader: FileSystemDirectoryReader
): Promise<FileSystemEntry[]> {
  const all: FileSystemEntry[] = []
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve) => {
      reader.readEntries(resolve, () => resolve([]))
    })
    if (batch.length === 0) return all
    all.push(...batch)
    // Guard against a reader that never empties, rather than looping forever.
    if (all.length > MAX_DROP_FILES) return all
  }
}
