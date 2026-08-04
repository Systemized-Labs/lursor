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
 * One of the two side-by-side editor groups a file's tab can sit in. Group 0 is
 * the only one until something splits; group 1 exists exactly while a file is
 * shown in it.
 */
export type EditorGroup = 0 | 1

/** A position to scroll to and select once an editor is showing the file. */
export interface RevealTarget {
  /** 1-based line. */
  line: number
  /** 1-based column; defaults to the start of the line. */
  column?: number
  /** Characters to select from `column` — the matched text, for a search hit. */
  length?: number
}

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
  /**
   * Which editor groups show this file — a *set*, not a single group, because
   * splitting a file puts one buffer in two views. Never empty: a file with no
   * group left is closed outright.
   */
  groups: EditorGroup[]
  /** Where to jump once an editor is up; cleared by `clearReveal` on arrival. */
  reveal?: RevealTarget
  /**
   * Bumped each time the file changes on disk. Text buffers don't need it — their
   * new content *is* the signal — but a media file's bytes never pass through
   * here, so its preview has nothing else to notice: same path, same URL, same
   * props, and an agent that regenerates a video would leave the old one on
   * screen. The preview hangs its cache-buster off this.
   */
  revision: number
}

/** Extras for {@link FileBuffers.openFile} beyond the path and name. */
export interface OpenFileOptions {
  /** Which group to open in; defaults to whichever group has focus. */
  group?: EditorGroup
  /** Scroll to and select this position once the buffer is on screen. */
  reveal?: RevealTarget
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
// Formats a browser's own `<video>`/`<audio>` element can be expected to play.
// Deliberately not every container that exists: an `.avi` or `.wmv` in a media
// player produces a dead black rectangle, which is a worse answer than the
// binary notice. A container listed here whose *codec* the browser lacks still
// fails, and the player reports that itself — see `MediaPreview`.
const VIDEO_EXTS = new Set(["mp4", "m4v", "webm", "ogv", "mov"])
const AUDIO_EXTS = new Set([
  "mp3",
  "wav",
  "ogg",
  "oga",
  "opus",
  "m4a",
  "aac",
  "flac",
  "weba",
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
export const isVideoFile = (name: string) => VIDEO_EXTS.has(extOf(name))
export const isAudioFile = (name: string) => AUDIO_EXTS.has(extOf(name))
/** Anything the editor shows in a player rather than in Monaco. */
export const isMediaFile = (name: string) =>
  isImageFile(name) || isVideoFile(name) || isAudioFile(name)
export const isMarkdownFile = (name: string) => MARKDOWN_EXTS.has(extOf(name))
export const isProseFile = (name: string) => PROSE_EXTS.has(extOf(name))

/** Everything an editor pane needs to render and mutate the open tabs. */
export interface FileBuffers {
  openFiles: OpenFile[]
  /** The active file in each group; `undefined` for a group showing nothing. */
  activePaths: [string | undefined, string | undefined]
  /** Which group the user last interacted with — where a newly opened file lands. */
  focusedGroup: EditorGroup
  /**
   * The focused group's active file. Derived, and kept because most callers only
   * ever deal with one editor: the skill dialog, the tree's "you are here"
   * highlight, and the dock tab's detail label all want "the file on screen".
   */
  activePath?: string
  /** Whether group 1 is showing anything — i.e. whether the pane is split. */
  split: boolean
  setActivePath: (path: string | undefined, group?: EditorGroup) => void
  setFocusedGroup: (group: EditorGroup) => void
  openFile: (
    path: string,
    name: string,
    options?: OpenFileOptions
  ) => Promise<void>
  /** Close a file in one group, or (with no group) drop it everywhere. */
  closeFile: (path: string, group?: EditorGroup) => void
  /** Show an already-open file in the *other* group too — one buffer, two views. */
  splitFile: (path: string) => void
  /** Move a file's tab so it shows only in `group`. */
  moveToGroup: (path: string, group: EditorGroup) => void
  /** Fold a group away, moving anything only it held back to group 0. */
  closeGroup: (group: EditorGroup) => void
  saveFile: (path: string) => Promise<void>
  discardChanges: (path: string) => void
  copyPath: (path: string) => Promise<void>
  patch: (path: string, update: Partial<OpenFile>) => void
  /** Forget a consumed {@link RevealTarget}, so it fires exactly once. */
  clearReveal: (path: string) => void
  /** Re-read one file after an external change (a watcher, or an agent edit). */
  reconcile: (path: string, change: FileChangeKind) => Promise<void>
  isOpen: (path: string) => boolean
  settings: EditorSettings
  setSetting: <K extends keyof EditorSettings>(
    key: K,
    value: EditorSettings[K]
  ) => void
}

/** Files whose tab belongs to `group`, in tab order. */
export const filesInGroup = (files: OpenFile[], group: EditorGroup) =>
  files.filter((f) => f.groups.includes(group))

/**
 * The buffer state machine behind every editor in the app: open files as tabs,
 * each tracking its buffer against the on-disk baseline, with save, discard,
 * debounced auto-save and conflict detection when a file moves under unsaved
 * edits.
 *
 * Deliberately knows nothing about *where* the files live — that is the
 * {@link FileSource} — so the workspace editor and the skill editor share one
 * implementation and behave identically.
 *
 * **One store, two groups.** A split pane is modelled as tabs tagged with a
 * group, not as two `useFileBuffers`. Two stores would each need their own
 * watcher fan-out and reconcile path, and the same file open in both would give
 * one file on disk two independent dirty buffers — a conflict generator. Here
 * `saveFile`, `reconcile` and auto-save stay keyed on path alone and are simply
 * unaware that a file might be visible twice.
 */
export function useFileBuffers(source: FileSource | undefined): FileBuffers {
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
  const [activePaths, setActivePaths] = useState<
    [string | undefined, string | undefined]
  >([undefined, undefined])
  const [focusedGroup, setFocusedGroup] = useState<EditorGroup>(0)

  const patch = useCallback((path: string, update: Partial<OpenFile>) => {
    setOpenFiles((prev) =>
      prev.map((f) => (f.path === path ? { ...f, ...update } : f))
    )
  }, [])

  const clearReveal = useCallback(
    (path: string) => patch(path, { reveal: undefined }),
    [patch]
  )

  const setActivePath = useCallback(
    (path: string | undefined, group?: EditorGroup) => {
      const target = group ?? focusedGroup
      setActivePaths((prev) => {
        if (prev[target] === path) return prev
        const next: [string | undefined, string | undefined] = [...prev]
        next[target] = path
        return next
      })
      if (group !== undefined) setFocusedGroup(group)
    },
    [focusedGroup]
  )

  // Keep a live ref to open paths so watchers don't have to re-subscribe on every
  // keystroke, and so `openFile` can dedupe without reading state mid-update.
  const openPathsRef = useRef<Map<string, OpenFile>>(new Map())
  useEffect(() => {
    openPathsRef.current = new Map(openFiles.map((f) => [f.path, f]))
  }, [openFiles])

  const isOpen = useCallback((path: string) => openPathsRef.current.has(path), [])

  const openFile = useCallback(
    async (path: string, name: string, options?: OpenFileOptions) => {
      const group = options?.group ?? focusedGroup
      setActivePath(path, group)
      // Read existence from a ref, not from inside the setState updater: React
      // doesn't guarantee the updater runs synchronously, so reading a flag it
      // sets is unreliable and would re-fetch (clobbering unsaved edits) on a
      // file that's already open.
      const already = openPathsRef.current.has(path)
      setOpenFiles((prev) => {
        const existing = prev.find((f) => f.path === path)
        if (existing) {
          // Already open: show it in this group as well if it wasn't there, and
          // take the new reveal. The buffer itself is left alone — re-opening a
          // file must never discard unsaved edits.
          return prev.map((f) =>
            f.path === path
              ? {
                  ...f,
                  groups: f.groups.includes(group)
                    ? f.groups
                    : [...f.groups, group],
                  reveal: options?.reveal ?? f.reveal,
                  // Asking for a line means asking for the source. A doc sitting
                  // in its rendered preview has no line 42 to scroll to.
                  view:
                    options?.reveal && f.view !== "code" ? "code" : f.view,
                }
              : f
          )
        }
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
            // Docs open rendered by default; everything else as source. A reveal
            // overrides that — there is no line 42 in a rendered preview.
            view:
              isMarkdownFile(name) && !options?.reveal ? "preview" : "code",
            groups: [group],
            reveal: options?.reveal,
            revision: 0,
          },
        ]
      })
      if (already || !source) return
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
    [source, patch, setActivePath, focusedGroup]
  )

  /**
   * Re-point any group whose active file just vanished, and fold the split away
   * once group 1 is empty. Falls back *within* the group, so closing a tab on the
   * right never jumps the user to a file on the left.
   */
  const reconcileActive = useCallback((files: OpenFile[]) => {
    setActivePaths((prev) => {
      const next = ([0, 1] as EditorGroup[]).map((group) => {
        const inGroup = filesInGroup(files, group)
        const current = prev[group]
        if (current && inGroup.some((f) => f.path === current)) return current
        return inGroup[inGroup.length - 1]?.path
      }) as [string | undefined, string | undefined]
      return next[0] === prev[0] && next[1] === prev[1] ? prev : next
    })
    if (!files.some((f) => f.groups.includes(1))) setFocusedGroup(0)
  }, [])

  // The three group mutations below read their target from `openPathsRef` rather
  // than from inside the `setOpenFiles` updater. React may run an updater more
  // than once, and `closeFile`'s confirm prompt is not something to show twice.
  const closeFile = useCallback(
    (path: string, group?: EditorGroup) => {
      const target = openPathsRef.current.get(path)
      if (!target) return
      // Closing the last view of a dirty buffer is what loses work; hiding one of
      // two views of it loses nothing, so that case asks nothing.
      const losesBuffer =
        group === undefined || target.groups.every((g) => g === group)
      if (
        losesBuffer &&
        target.dirty &&
        !window.confirm(`Discard unsaved changes to ${target.name}?`)
      ) {
        return
      }
      setOpenFiles((prev) => {
        const next = losesBuffer
          ? prev.filter((f) => f.path !== path)
          : prev.map((f) =>
              f.path === path
                ? { ...f, groups: f.groups.filter((g) => g !== group) }
                : f
            )
        reconcileActive(next)
        return next
      })
    },
    [reconcileActive]
  )

  const splitFile = useCallback(
    (path: string) => {
      const target = openPathsRef.current.get(path)
      if (!target) return
      // Into whichever group this file isn't in yet. One buffer, two views:
      // Monaco keys models by path, so both editors share the model — edits and
      // undo stay in step while each view keeps its own scroll and cursor, which
      // is exactly what a same-file split wants.
      const to: EditorGroup = target.groups.includes(1) ? 0 : 1
      if (target.groups.includes(to)) return
      setOpenFiles((prev) =>
        prev.map((f) =>
          f.path === path ? { ...f, groups: [...f.groups, to] } : f
        )
      )
      setActivePath(path, to)
    },
    [setActivePath]
  )

  const moveToGroup = useCallback(
    (path: string, group: EditorGroup) => {
      const target = openPathsRef.current.get(path)
      if (!target) return
      if (target.groups.length === 1 && target.groups[0] === group) return
      setOpenFiles((prev) => {
        const next = prev.map((f) =>
          f.path === path ? { ...f, groups: [group] } : f
        )
        reconcileActive(next)
        return next
      })
      setActivePath(path, group)
    },
    [reconcileActive, setActivePath]
  )

  const closeGroup = useCallback(
    (group: EditorGroup) => {
      // Group 0 *is* the pane; there is no layout left to fold it into.
      if (group === 0) return
      setOpenFiles((prev) => {
        const next = prev.map((f): OpenFile => {
          if (!f.groups.includes(group)) return f
          const remaining = f.groups.filter((g) => g !== group)
          // Folding a group away closes nothing — a file only that group held
          // moves across rather than being thrown out with the layout.
          return { ...f, groups: remaining.length ? remaining : [0] }
        })
        reconcileActive(next)
        return next
      })
      setFocusedGroup(0)
    },
    [reconcileActive]
  )

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
      // A media file has no buffer to reconcile — the preview loads the bytes
      // itself. Re-reading it would only spend a round trip to be told it's
      // binary again, so bump the revision (which is what makes the preview
      // refetch) and stop there. `status` matters for a file that arrived after
      // being reported deleted.
      const media = openPathsRef.current.get(path)
      if (media && isMediaFile(media.name)) {
        setOpenFiles((prev) =>
          prev.map((f) =>
            f.path === path
              ? { ...f, status: "ready", revision: f.revision + 1 }
              : f
          )
        )
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
              revision: f.revision + 1,
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
    activePaths,
    focusedGroup,
    activePath: activePaths[focusedGroup],
    split: openFiles.some((f) => f.groups.includes(1)),
    setActivePath,
    setFocusedGroup,
    openFile,
    closeFile,
    splitFile,
    moveToGroup,
    closeGroup,
    saveFile,
    discardChanges,
    copyPath,
    patch,
    clearReveal,
    reconcile,
    isOpen,
    settings,
    setSetting,
  }
}
