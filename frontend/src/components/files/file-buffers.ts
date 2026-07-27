import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { useEditorSettings } from "@/hooks/use-editor-settings"
import { AUTO_SAVE_DELAY_MS } from "@/lib/editor-settings"
import type { EditorSettings } from "@/lib/editor-settings"

/** How a text file renders in the editor pane. */
export type ViewMode = "code" | "preview" | "split"

/** What a change event says happened to a file the editor has open. */
export type FileChangeKind = "added" | "modified" | "deleted"

/**
 * Where an editor's files come from. Anything that can read and write a file by
 * relative path can be edited with {@link useFileBuffers} — a workspace
 * directory, a skill folder, anything served the same way.
 */
export interface FileSource {
  read(
    path: string
  ): Promise<{ content: string; is_binary: boolean; truncated: boolean }>
  write(path: string, content: string): Promise<void>
  /** Direct URL for bytes, when the backend can serve them (inline images). */
  rawUrl?(path: string): string
}

/** One file open in a tab, with its buffer, on-disk baseline, and load state. */
export interface OpenFile {
  path: string
  name: string
  content: string
  /** Last content we know is on disk — the baseline for dirty + conflict checks. */
  diskContent: string
  dirty: boolean
  isBinary: boolean
  truncated: boolean
  status: "loading" | "ready" | "error" | "deleted"
  error?: string
  saving: boolean
  /** New on-disk content that landed while the buffer had unsaved edits. */
  conflict?: string
  /** Show this tab as a disk-vs-buffer diff instead of a plain editor. */
  diffView: boolean
  /** Editor / rendered preview / split — only "preview"/"split" for markdown. */
  view: ViewMode
}

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "avif",
])
const MARKDOWN_EXTS = new Set(["md", "mdx", "markdown"])
// Prose files wrap by default even when the global Word Wrap toggle is off —
// long-form text shouldn't run off the right edge like code sometimes wants to.
const PROSE_EXTS = new Set(["md", "mdx", "markdown", "txt", "text", "rst"])

function extOf(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ""
}
export const isImageFile = (name: string) => IMAGE_EXTS.has(extOf(name))
export const isMarkdownFile = (name: string) => MARKDOWN_EXTS.has(extOf(name))
export const isProseFile = (name: string) => PROSE_EXTS.has(extOf(name))

/** Everything an editor pane needs to render and mutate the open tabs. */
export interface FileBuffers {
  openFiles: OpenFile[]
  activePath?: string
  setActivePath: (path: string | undefined) => void
  openFile: (path: string, name: string) => Promise<void>
  closeFile: (path: string) => void
  saveFile: (path: string) => Promise<void>
  discardChanges: (path: string) => void
  copyPath: (path: string) => Promise<void>
  patch: (path: string, update: Partial<OpenFile>) => void
  /** Re-read one file after an external change (a watcher, or an agent edit). */
  reconcile: (path: string, change: FileChangeKind) => Promise<void>
  isOpen: (path: string) => boolean
  settings: EditorSettings
  setSetting: <K extends keyof EditorSettings>(
    key: K,
    value: EditorSettings[K]
  ) => void
}

/**
 * The buffer state machine behind every editor in the app: open files as tabs,
 * each tracking its buffer against the on-disk baseline, with save, discard,
 * debounced auto-save and conflict detection when a file moves under unsaved
 * edits.
 *
 * Deliberately knows nothing about *where* the files live — that is the
 * {@link FileSource} — so the workspace editor and the skill editor share one
 * implementation and behave identically.
 */
export function useFileBuffers(source: FileSource | undefined): FileBuffers {
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
  const [activePath, setActivePath] = useState<string | undefined>(undefined)

  const patch = useCallback((path: string, update: Partial<OpenFile>) => {
    setOpenFiles((prev) =>
      prev.map((f) => (f.path === path ? { ...f, ...update } : f))
    )
  }, [])

  // Keep a live ref to open paths so watchers don't have to re-subscribe on every
  // keystroke, and so `openFile` can dedupe without reading state mid-update.
  const openPathsRef = useRef<Map<string, OpenFile>>(new Map())
  useEffect(() => {
    openPathsRef.current = new Map(openFiles.map((f) => [f.path, f]))
  }, [openFiles])

  const isOpen = useCallback((path: string) => openPathsRef.current.has(path), [])

  const openFile = useCallback(
    async (path: string, name: string) => {
      setActivePath(path)
      // Read existence from a ref, not from inside the setState updater: React
      // doesn't guarantee the updater runs synchronously, so reading a flag it
      // sets is unreliable and would re-fetch (clobbering unsaved edits) on a
      // file that's already open.
      if (openPathsRef.current.has(path)) return
      setOpenFiles((prev) => {
        if (prev.some((f) => f.path === path)) return prev
        return [
          ...prev,
          {
            path,
            name,
            content: "",
            diskContent: "",
            dirty: false,
            isBinary: false,
            truncated: false,
            status: "loading",
            saving: false,
            diffView: false,
            // Docs open rendered by default; everything else as source.
            view: isMarkdownFile(name) ? "preview" : "code",
          },
        ]
      })
      if (!source) return
      try {
        const file = await source.read(path)
        patch(path, {
          content: file.content,
          diskContent: file.content,
          isBinary: file.is_binary,
          truncated: file.truncated,
          status: "ready",
        })
      } catch (err) {
        patch(path, {
          status: "error",
          error: err instanceof Error ? err.message : "Failed to read file",
        })
      }
    },
    [source, patch]
  )

  const closeFile = useCallback((path: string) => {
    setOpenFiles((prev) => {
      const target = prev.find((f) => f.path === path)
      if (
        target?.dirty &&
        !window.confirm(`Discard unsaved changes to ${target.name}?`)
      ) {
        return prev
      }
      const next = prev.filter((f) => f.path !== path)
      setActivePath((cur) => (cur === path ? next[next.length - 1]?.path : cur))
      return next
    })
  }, [])

  const saveFile = useCallback(
    async (path: string) => {
      if (!source) return
      const file = openFiles.find((f) => f.path === path)
      if (!file || !file.dirty || file.saving) return
      patch(path, { saving: true })
      try {
        await source.write(path, file.content)
        // The buffer is now the on-disk truth; clear dirty + any conflict.
        patch(path, {
          diskContent: file.content,
          dirty: false,
          saving: false,
          conflict: undefined,
          status: "ready",
        })
      } catch (err) {
        patch(path, { saving: false })
        toast.error(err instanceof Error ? err.message : "Failed to save file")
      }
    },
    [source, openFiles, patch]
  )

  // Drop unsaved edits and snap the buffer back to the on-disk baseline. The
  // new `content` flows into Monaco via its `value` prop.
  const discardChanges = useCallback((path: string) => {
    setOpenFiles((prev) =>
      prev.map((f) =>
        f.path === path
          ? { ...f, content: f.diskContent, dirty: false, conflict: undefined }
          : f
      )
    )
  }, [])

  const copyPath = useCallback(async (path: string) => {
    try {
      await navigator.clipboard.writeText(path)
      toast.success("Copied relative path")
    } catch {
      toast.error("Couldn’t copy path")
    }
  }, [])

  // --- Auto save -------------------------------------------------------------
  // When enabled, save every dirty buffer a short beat after edits settle.
  // `openFiles` changes on each keystroke, so the timer resets until typing
  // pauses — a debounce, not a fixed interval.
  const { settings, setSetting } = useEditorSettings()
  const autoSave = settings.autoSave
  useEffect(() => {
    if (!autoSave || !source) return
    // Skip files with an unresolved conflict so auto-save never silently
    // clobbers a change that landed on disk under the user's edits.
    const dirty = openFiles.filter(
      (f) =>
        f.dirty && !f.saving && f.status === "ready" && f.conflict === undefined
    )
    if (dirty.length === 0) return
    const timer = setTimeout(() => {
      for (const f of dirty) void saveFile(f.path)
    }, AUTO_SAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [autoSave, source, openFiles, saveFile])

  // Reconcile one open file against disk after a change event: accept the new
  // content into a clean buffer (live agent edit) or flag a conflict if the
  // buffer has unsaved edits.
  const reconcile = useCallback(
    async (path: string, change: FileChangeKind) => {
      if (!source) return
      if (change === "deleted") {
        patch(path, { status: "deleted" })
        return
      }
      try {
        const file = await source.read(path)
        setOpenFiles((prev) =>
          prev.map((f) => {
            if (f.path !== path) return f
            if (f.dirty && file.content !== f.diskContent) {
              // Disk moved under unsaved edits — keep the buffer, offer a merge.
              return { ...f, diskContent: file.content, conflict: file.content }
            }
            return {
              ...f,
              content: file.content,
              diskContent: file.content,
              isBinary: file.is_binary,
              truncated: file.truncated,
              status: "ready",
              conflict: undefined,
            }
          })
        )
      } catch {
        // A transient read failure (e.g. mid-write) is fine to ignore; the next
        // change event will reconcile again.
      }
    },
    [source, patch]
  )

  return {
    openFiles,
    activePath,
    setActivePath,
    openFile,
    closeFile,
    saveFile,
    discardChanges,
    copyPath,
    patch,
    reconcile,
    isOpen,
    settings,
    setSetting,
  }
}
