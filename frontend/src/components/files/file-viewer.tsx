import { useCallback, useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  Warning,
  CaretRight,
  FileImage,
  FileX,
  FolderOpen,
  FloppyDisk,
  ArrowsOut,
  ArrowCounterClockwise,
  Copy,
  DotsThree,
  GitDiff,
  SidebarSimple,
  X,
} from "@phosphor-icons/react"
import { toast } from "sonner"

import { filesApi } from "@/api/files"
import type { FileChange } from "@/api/files"
import { useFileWatch } from "@/hooks/use-file-watch"
import { useEditorSettings } from "@/hooks/use-editor-settings"
import { AUTO_SAVE_DELAY_MS } from "@/lib/editor-settings"
import type { EditorSettings } from "@/lib/editor-settings"
import { consumePendingFile, subscribeOpenFile } from "@/lib/open-file"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { MarkdownRenderer } from "@/components/ui/markdown-renderer"
import { cn } from "@/lib/utils"

import { CodeEditor, DiffCodeEditor } from "./code-editor"
import { FileExplorer } from "./file-explorer"
import { fileKind } from "./file-icon"

/** How a text file renders in the editor pane. */
type ViewMode = "code" | "preview" | "split"

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
const isImageFile = (name: string) => IMAGE_EXTS.has(extOf(name))
const isMarkdownFile = (name: string) => MARKDOWN_EXTS.has(extOf(name))
const isProseFile = (name: string) => PROSE_EXTS.has(extOf(name))

/**
 * A "plan" doc — the goal agent's `GOAL_PLAN.md` and its kin (`PLAN.md`,
 * `PROJECT_PLAN.md`, …). Matched on a whole "plan" token so `planner.md` and
 * `explanation.md` don't qualify. These open full-width (tree collapsed) since
 * they're meant to be read, not navigated away from.
 */
function isPlanFile(name: string): boolean {
  if (!isMarkdownFile(name)) return false
  const base = name.slice(0, name.length - extOf(name).length - 1).toLowerCase()
  return base.split(/[^a-z0-9]+/).includes("plan")
}

/** Persisted flag: is the file tree collapsed out of the viewer? */
const TREE_HIDDEN_STORAGE_KEY = "lursor-file-tree-hidden"

/** Platform-aware save shortcut, resolved once for header hints. */
const SAVE_HINT =
  typeof navigator !== "undefined" && /Mac|iP/.test(navigator.platform)
    ? "⌘S"
    : "Ctrl+S"

/** One file open in a tab, with its buffer, on-disk baseline, and load state. */
interface OpenFile {
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

interface FileViewerProps {
  workspaceId?: string
}

/**
 * A lightweight, VS Code-style editor for a workspace: a file tree, multiple
 * open files as tabs, and a Monaco editor. A filesystem watcher streams changes
 * so edits made by a running agent appear live — reloading a clean buffer in
 * place, or flagging a conflict when the file changed under unsaved edits.
 */
export function FileViewer({ workspaceId }: FileViewerProps) {
  const qc = useQueryClient()
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
  const [activePath, setActivePath] = useState<string | undefined>(undefined)
  const [treeHidden, setTreeHidden] = useState(
    () =>
      typeof localStorage !== "undefined" &&
      localStorage.getItem(TREE_HIDDEN_STORAGE_KEY) === "1"
  )

  const toggleTree = useCallback(() => {
    setTreeHidden((prev) => {
      const next = !prev
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(TREE_HIDDEN_STORAGE_KEY, next ? "1" : "0")
      }
      return next
    })
  }, [])

  const patch = useCallback(
    (path: string, update: Partial<OpenFile>) => {
      setOpenFiles((prev) =>
        prev.map((f) => (f.path === path ? { ...f, ...update } : f))
      )
    },
    []
  )

  const openFile = useCallback(
    async (path: string, name: string) => {
      setActivePath(path)
      // Read existence from a ref, not from inside the setState updater: React
      // doesn't guarantee the updater runs synchronously, so reading a flag it
      // sets is unreliable and would re-fetch (clobbering unsaved edits) on a
      // file that's already open.
      if (openPathsRef.current.has(path)) return
      // Plan docs open full-width: collapse the tree on first open. Not
      // persisted — it's a per-session nudge, not a change to the saved
      // preference, and the toggle brings the tree right back.
      if (isPlanFile(name)) setTreeHidden(true)
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
      if (!workspaceId) return
      try {
        const file = await filesApi.read(workspaceId, path)
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
    [workspaceId, patch]
  )

  // Open files requested from elsewhere (e.g. the global command palette). We
  // consume a pending request on mount and whenever a new one is parked, so a
  // freshly-opened file tab or an already-open viewer both react.
  useEffect(() => {
    const tryOpen = () => {
      const request = consumePendingFile(workspaceId)
      if (request) void openFile(request.path, request.name)
    }
    tryOpen()
    return subscribeOpenFile(tryOpen)
  }, [workspaceId, openFile])

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
      setActivePath((cur) =>
        cur === path ? next[next.length - 1]?.path : cur
      )
      return next
    })
  }, [])

  const saveFile = useCallback(
    async (path: string) => {
      if (!workspaceId) return
      const file = openFiles.find((f) => f.path === path)
      if (!file || !file.dirty || file.saving) return
      patch(path, { saving: true })
      try {
        await filesApi.write(workspaceId, path, file.content)
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
    [workspaceId, openFiles, patch]
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
    if (!autoSave || !workspaceId) return
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
  }, [autoSave, workspaceId, openFiles, saveFile])

  // --- Live filesystem watch -------------------------------------------------
  // Reconcile one open file against disk after a change event: accept the new
  // content into a clean buffer (live agent edit) or flag a conflict if the
  // buffer has unsaved edits.
  const reconcile = useCallback(
    async (path: string, change: FileChange["type"]) => {
      if (!workspaceId) return
      if (change === "deleted") {
        patch(path, { status: "deleted" })
        return
      }
      try {
        const file = await filesApi.read(workspaceId, path)
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
    [workspaceId, patch]
  )

  // Keep a live ref to open paths so the watch socket doesn't reconnect on every
  // keystroke — the effect below depends only on the workspace.
  const openPathsRef = useRef<Map<string, OpenFile>>(new Map())
  useEffect(() => {
    openPathsRef.current = new Map(openFiles.map((f) => [f.path, f]))
  }, [openFiles])

  useFileWatch(
    workspaceId,
    useCallback(
      (changes: FileChange[]) => {
        // Refresh the tree (adds/removes/renames) regardless of open files.
        qc.invalidateQueries({ queryKey: ["files", workspaceId, "dir"] })
        // Reconcile the last change per open file.
        const latest = new Map<string, FileChange["type"]>()
        for (const c of changes) {
          if (openPathsRef.current.has(c.path)) latest.set(c.path, c.type)
        }
        for (const [path, type] of latest) reconcile(path, type)
      },
      [workspaceId, qc, reconcile]
    )
  )

  if (!workspaceId) {
    return (
      <div className="flex-1 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Open a workspace to browse its files.
      </div>
    )
  }

  const active = openFiles.find((f) => f.path === activePath)

  // The tree can only be hidden once a file is open — with no file open you'd
  // have no way to reach one, so force it visible there regardless of the pref.
  const showTree = openFiles.length === 0 || !treeHidden

  const editorPane =
    openFiles.length === 0 ? (
      <EmptyEditor />
    ) : (
      <>
        <TabStrip
          files={openFiles}
          activePath={activePath}
          treeHidden={treeHidden}
          onActivate={setActivePath}
          onClose={closeFile}
          onToggleTree={toggleTree}
        />
        {active && (
          <EditorBody
            file={active}
            workspaceId={workspaceId}
            settings={settings}
            setSetting={setSetting}
            onSetView={(view) => patch(active.path, { view })}
            onChange={(value) =>
              patch(active.path, {
                content: value,
                dirty: value !== active.diskContent,
              })
            }
            onSave={() => saveFile(active.path)}
            onDiscard={() => discardChanges(active.path)}
            onCopyPath={() => copyPath(active.path)}
            onToggleDiff={() =>
              patch(active.path, { diffView: !active.diffView })
            }
            onReloadConflict={() =>
              patch(active.path, {
                content: active.conflict ?? active.content,
                dirty: false,
                conflict: undefined,
              })
            }
            onDismissConflict={() =>
              patch(active.path, { conflict: undefined })
            }
          />
        )}
      </>
    )

  // With the tree hidden the editor takes the whole pane — no resizable group,
  // which also sidesteps the panel-count churn a conditional panel would cause.
  if (!showTree) {
    return (
      <div className="flex-1 min-h-0 flex flex-col bg-card">{editorPane}</div>
    )
  }

  return (
    <ResizablePanelGroup
      direction="horizontal"
      autoSaveId="file-viewer-v2"
      className="flex-1 min-h-0"
    >
      <ResizablePanel minSize={30} className="flex flex-col min-w-0 bg-card">
        {editorPane}
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize={28} minSize={15} className="flex flex-col min-w-0">
        <FileExplorer
          workspaceId={workspaceId}
          activePath={activePath}
          onOpenFile={openFile}
        />
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

interface TabStripProps {
  files: OpenFile[]
  activePath?: string
  treeHidden: boolean
  onActivate: (path: string) => void
  onClose: (path: string) => void
  onToggleTree: () => void
}

function TabStrip({
  files,
  activePath,
  treeHidden,
  onActivate,
  onClose,
  onToggleTree,
}: TabStripProps) {
  // Keep the open tab in view when it changes — activating a file from the tree
  // (or closing a neighbour) can leave the active tab scrolled off-screen.
  const activeRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [activePath])

  return (
    <div className="flex h-9 min-w-0 shrink-0 items-stretch border-b border-border/40 bg-muted/30">
      <div className="no-scrollbar flex min-w-0 flex-1 items-stretch overflow-x-auto">
      {files.map((f) => {
        const isActive = f.path === activePath
        const { Icon: Glyph } = fileKind(f.name)
        return (
          <div
            key={f.path}
            ref={isActive ? activeRef : undefined}
            role="tab"
            aria-selected={isActive}
            tabIndex={0}
            onClick={() => onActivate(f.path)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onActivate(f.path)
            }}
            title={f.path}
            className={cn(
              "group relative flex items-center gap-1.5 px-3 text-xs whitespace-nowrap cursor-pointer outline-none transition-colors",
              // The active tab takes the editor's own surface (`card`) so it
              // reads as one continuous panel; others stay on the muted strip.
              // Layering, not borders, separates them — no lines between tabs.
              isActive
                ? "bg-card text-foreground"
                : "text-muted-foreground hover:bg-card/50 hover:text-foreground focus-visible:bg-card/50"
            )}
          >
            {/* Active rail — mirrors the tree's left rail across the top of the tab. */}
            {isActive && (
              <span className="absolute inset-x-0 top-0 h-0.5 bg-primary" />
            )}
            <Glyph
              className={cn(
                "h-3.5 w-3.5 shrink-0",
                isActive ? "text-foreground" : "text-muted-foreground/80"
              )}
            />
            <span>{f.name}</span>
            {/* Fixed trailing slot: a dirty dot that becomes the close target on
                hover/focus — so the tab width never jumps. */}
            <span className="relative ml-0.5 flex h-4 w-4 items-center justify-center">
              {f.dirty && (
                <span
                  className="h-1.5 w-1.5 rounded-full bg-foreground/70 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
                  aria-label="Unsaved changes"
                />
              )}
              <button
                type="button"
                aria-label={`Close ${f.name}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(f.path)
                }}
                className="absolute inset-0 flex items-center justify-center rounded opacity-0 outline-none hover:bg-background/60 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring group-hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          </div>
        )
      })}
      </div>
      {/* Pinned to the right of the scrolling tabs so it's always reachable —
          the only way back to the tree once it's hidden. */}
      <button
        type="button"
        onClick={onToggleTree}
        aria-pressed={treeHidden}
        title={treeHidden ? "Show file tree" : "Hide file tree"}
        aria-label={treeHidden ? "Show file tree" : "Hide file tree"}
        className={cn(
          "flex w-9 shrink-0 items-center justify-center border-l border-border/40 outline-none transition-colors hover:bg-card/50 hover:text-foreground focus-visible:bg-card/50",
          treeHidden ? "text-muted-foreground" : "text-foreground"
        )}
      >
        <SidebarSimple
          className="h-4 w-4 -scale-x-100"
          weight={treeHidden ? "regular" : "fill"}
        />
      </button>
    </div>
  )
}

interface EditorBodyProps {
  file: OpenFile
  workspaceId?: string
  settings: EditorSettings
  setSetting: <K extends keyof EditorSettings>(
    key: K,
    value: EditorSettings[K]
  ) => void
  onSetView: (view: ViewMode) => void
  onChange: (value: string) => void
  onSave: () => void
  onDiscard: () => void
  onCopyPath: () => void
  onToggleDiff: () => void
  onReloadConflict: () => void
  onDismissConflict: () => void
}

function EditorBody({
  file,
  workspaceId,
  settings,
  setSetting,
  onSetView,
  onChange,
  onSave,
  onDiscard,
  onCopyPath,
  onToggleDiff,
  onReloadConflict,
  onDismissConflict,
}: EditorBodyProps) {
  if (file.status === "loading") {
    return <Centered title={`Opening ${file.name}`}>Reading from disk…</Centered>
  }
  if (file.status === "error") {
    return (
      <Centered icon={Warning} title="Couldn’t open this file">
        {file.error ?? "The file couldn’t be read. Try opening it again."}
      </Centered>
    )
  }
  if (file.status === "deleted") {
    return (
      <Centered icon={FileX} title="Deleted on disk">
        {file.name} no longer exists. Close the tab, or save to write it back.
      </Centered>
    )
  }
  // Images render inline from the raw endpoint — checked before the binary/size
  // dead-ends, since `/read` reports images as binary and large ones as too big.
  if (isImageFile(file.name) && workspaceId) {
    return (
      <ImagePreview
        src={filesApi.rawUrl(workspaceId, file.path)}
        name={file.name}
      />
    )
  }
  if (file.isBinary) {
    return (
      <Centered icon={FileImage} title="Binary file">
        This file isn’t text, so it can’t be shown in the editor.
      </Centered>
    )
  }
  if (file.truncated) {
    return (
      <Centered icon={ArrowsOut} title="File too large">
        This file is too big to open here. Use the terminal to work with it.
      </Centered>
    )
  }

  const { label: language } = fileKind(file.name)
  const lineCount = file.content.length ? file.content.split("\n").length : 0
  const markdown = isMarkdownFile(file.name)
  // Prose wraps by default; the global toggle can only add wrapping, not remove
  // it for a doc. Everything else follows the Word Wrap setting verbatim.
  const display = {
    ...settings,
    wordWrap: settings.wordWrap || isProseFile(file.name),
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {file.conflict !== undefined && (
        <div className="flex items-center gap-2 border-b border-border/40 bg-accent/40 px-3 py-1.5 text-xs text-foreground">
          <Warning className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="flex-1">
            This file changed on disk while you had unsaved edits.
          </span>
          <button
            type="button"
            onClick={onReloadConflict}
            className="rounded px-1.5 py-0.5 font-medium hover:bg-background/60"
          >
            Use disk version
          </button>
          <button
            type="button"
            onClick={onDismissConflict}
            className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-background/60 hover:text-foreground"
          >
            Keep my edits
          </button>
        </div>
      )}
      <div className="flex h-8 min-w-0 shrink-0 items-center justify-between gap-3 border-b border-border/40 pl-3 pr-2">
        <Breadcrumb path={file.path} />
        <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
          {file.diffView && (
            <span className="hidden items-center gap-1 font-mono uppercase tracking-wide text-primary sm:inline-flex">
              <GitDiff className="h-3 w-3" />
              Diff
            </span>
          )}
          <span className="hidden font-mono uppercase tracking-wide sm:inline">
            {language}
          </span>
          {lineCount > 0 && (
            <span className="hidden font-mono tabular-nums sm:inline">
              {lineCount} {lineCount === 1 ? "line" : "lines"}
            </span>
          )}
          <button
            type="button"
            onClick={onSave}
            disabled={!file.dirty || file.saving}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors",
              "hover:bg-accent hover:text-foreground",
              "disabled:pointer-events-none disabled:opacity-40",
              file.dirty && !file.saving && "text-foreground"
            )}
            title={`Save (${SAVE_HINT})`}
          >
            <FloppyDisk className="h-3.5 w-3.5" />
            {file.saving ? "Saving…" : "Save"}
            {file.dirty && !file.saving && (
              <kbd className="hidden rounded border border-border/60 bg-muted px-1 font-mono text-[10px] leading-tight text-muted-foreground md:inline">
                {SAVE_HINT}
              </kbd>
            )}
          </button>
          <EditorMenu
            file={file}
            markdown={markdown}
            settings={settings}
            setSetting={setSetting}
            onSetView={onSetView}
            onSave={onSave}
            onDiscard={onDiscard}
            onCopyPath={onCopyPath}
            onToggleDiff={onToggleDiff}
          />
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {file.diffView ? (
          <DiffCodeEditor
            path={file.path}
            original={file.diskContent}
            modified={file.content}
            display={display}
            onChange={onChange}
          />
        ) : markdown && file.view === "preview" ? (
          <MarkdownPreview content={file.content} />
        ) : markdown && file.view === "split" ? (
          <ResizablePanelGroup
            direction="horizontal"
            autoSaveId="md-split"
            className="h-full"
          >
            <ResizablePanel minSize={25} className="min-w-0">
              <CodeEditor
                path={file.path}
                value={file.content}
                display={display}
                onChange={onChange}
                onSave={onSave}
              />
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel minSize={25} className="min-w-0">
              <MarkdownPreview content={file.content} />
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          <CodeEditor
            path={file.path}
            value={file.content}
            display={display}
            onChange={onChange}
            onSave={onSave}
          />
        )}
      </div>
    </div>
  )
}

/** Rendered Markdown in a scrollable, comfortably-padded reading column. */
function MarkdownPreview({ content }: { content: string }) {
  return (
    <div className="h-full overflow-auto bg-card px-6 py-5">
      <div className="mx-auto max-w-3xl">
        {content.trim() ? (
          <MarkdownRenderer>{content}</MarkdownRenderer>
        ) : (
          <p className="text-sm text-muted-foreground">This file is empty.</p>
        )}
      </div>
    </div>
  )
}

/** Inline image preview, centered on the editor surface with a size hint. */
function ImagePreview({ src, name }: { src: string; name: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 overflow-auto bg-card p-6">
      <img
        src={src}
        alt={name}
        className="max-h-full max-w-full rounded-md object-contain shadow-sm"
      />
      <p className="font-mono text-[11px] text-muted-foreground">{name}</p>
    </div>
  )
}

interface EditorMenuProps {
  file: OpenFile
  markdown: boolean
  settings: EditorSettings
  setSetting: <K extends keyof EditorSettings>(
    key: K,
    value: EditorSettings[K]
  ) => void
  onSetView: (view: ViewMode) => void
  onSave: () => void
  onDiscard: () => void
  onCopyPath: () => void
  onToggleDiff: () => void
}

/**
 * The header's overflow menu ("…"): file actions on top (save/discard/copy),
 * a render-mode picker for markdown, then display toggles. Toggle items keep
 * the menu open (`preventDefault`) so several can be flipped in one pass;
 * action items close as usual.
 */
function EditorMenu({
  file,
  markdown,
  settings,
  setSetting,
  onSetView,
  onSave,
  onDiscard,
  onCopyPath,
  onToggleDiff,
}: EditorMenuProps) {
  const canWrite = file.dirty && !file.saving
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-accent data-[state=open]:text-foreground"
        aria-label="Editor options"
        title="Editor options"
      >
        <DotsThree className="h-4 w-4" weight="bold" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={onSave} disabled={!canWrite}>
          <FloppyDisk className="h-4 w-4" />
          Save File
          <DropdownMenuShortcut>{SAVE_HINT}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onDiscard} disabled={!canWrite}>
          <ArrowCounterClockwise className="h-4 w-4" />
          Discard Changes
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onCopyPath}>
          <Copy className="h-4 w-4" />
          Copy Relative Path
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {markdown && (
          <>
            <DropdownMenuLabel>View</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={file.view}
              onValueChange={(v) => onSetView(v as ViewMode)}
            >
              <DropdownMenuRadioItem value="preview">
                Preview
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="code">Editor</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="split">Split</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuCheckboxItem
          checked={file.diffView}
          onSelect={(e) => e.preventDefault()}
          onCheckedChange={onToggleDiff}
        >
          Diff View
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={settings.lineNumbers}
          onSelect={(e) => e.preventDefault()}
          onCheckedChange={(v) => setSetting("lineNumbers", v)}
        >
          Line Numbers
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={settings.wordWrap}
          onSelect={(e) => e.preventDefault()}
          onCheckedChange={(v) => setSetting("wordWrap", v)}
        >
          Word Wrap
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={settings.minimap}
          onSelect={(e) => e.preventDefault()}
          onCheckedChange={(v) => setSetting("minimap", v)}
        >
          Minimap
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={settings.autoSave}
          onSelect={(e) => e.preventDefault()}
          onCheckedChange={(v) => setSetting("autoSave", v)}
        >
          Auto Save
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The active file's *location* — its folder path, muted and chevron-separated.
 * The filename is deliberately omitted: the tab already carries it, so echoing
 * it here (as the old breadcrumb did) only duplicated text for root-level files.
 * Renders as an empty flex slot at the root so the header's right cluster stays
 * pinned right.
 */
function Breadcrumb({ path }: { path: string }) {
  const folders = path.split("/").slice(0, -1)
  return (
    <nav
      aria-label="File location"
      className="flex min-w-0 items-center gap-1 overflow-hidden font-mono text-xs text-muted-foreground"
    >
      {folders.map((seg, i) => (
        <span key={i} className="flex min-w-0 shrink items-center gap-1">
          {i > 0 && (
            <CaretRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
          )}
          <span className="truncate">{seg}</span>
        </span>
      ))}
    </nav>
  )
}

/** Resting state before any file is open — an invitation, not a dead end. */
function EmptyEditor() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <FolderOpen className="h-7 w-7 text-muted-foreground/60" />
      <p className="text-sm font-medium text-foreground">No file open</p>
      <p className="max-w-xs text-xs text-muted-foreground">
        Pick a file from the explorer to read or edit it. Changes an agent makes
        show up here live.
      </p>
    </div>
  )
}

function Centered({
  icon: Icon,
  title,
  children,
}: {
  icon?: React.ElementType
  title?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 p-6 text-center">
      {Icon && <Icon className="mb-1 h-6 w-6 text-muted-foreground/60" />}
      {title && <p className="text-sm font-medium text-foreground">{title}</p>}
      <p className="max-w-xs text-xs text-muted-foreground">{children}</p>
    </div>
  )
}
