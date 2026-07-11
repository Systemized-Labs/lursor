import { useCallback, useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  AlertTriangle,
  ChevronRight,
  FileImage,
  FileX,
  FolderOpen,
  Save,
  Scaling,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { filesApi } from "@/api/files"
import type { FileChange } from "@/api/files"
import { useFileWatch } from "@/hooks/use-file-watch"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { cn } from "@/lib/utils"

import { CodeEditor } from "./code-editor"
import { FileExplorer } from "./file-explorer"
import { fileKind } from "./file-icon"

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

  return (
    <ResizablePanelGroup
      direction="horizontal"
      autoSaveId="file-viewer"
      className="flex-1 min-h-0"
    >
      <ResizablePanel defaultSize={28} minSize={15} className="flex flex-col min-w-0">
        <FileExplorer
          workspaceId={workspaceId}
          activePath={activePath}
          onOpenFile={openFile}
        />
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel minSize={30} className="flex flex-col min-w-0">
        {openFiles.length === 0 ? (
          <EmptyEditor />
        ) : (
          <>
            <TabStrip
              files={openFiles}
              activePath={activePath}
              onActivate={setActivePath}
              onClose={closeFile}
            />
            {active && (
              <EditorBody
                file={active}
                onChange={(value) =>
                  patch(active.path, {
                    content: value,
                    dirty: value !== active.diskContent,
                  })
                }
                onSave={() => saveFile(active.path)}
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
        )}
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

interface TabStripProps {
  files: OpenFile[]
  activePath?: string
  onActivate: (path: string) => void
  onClose: (path: string) => void
}

function TabStrip({ files, activePath, onActivate, onClose }: TabStripProps) {
  // Keep the open tab in view when it changes — activating a file from the tree
  // (or closing a neighbour) can leave the active tab scrolled off-screen.
  const activeRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [activePath])

  return (
    <div className="no-scrollbar flex h-9 min-w-0 shrink-0 items-stretch overflow-x-auto border-b border-border/60 bg-muted/30">
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
              // The active tab takes the editor's own surface so it reads as
              // one continuous panel; others stay on the muted strip. Layering,
              // not borders, separates them — no lines between tabs.
              isActive
                ? "bg-background text-foreground"
                : "text-muted-foreground hover:bg-background/50 hover:text-foreground focus-visible:bg-background/50"
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
  )
}

interface EditorBodyProps {
  file: OpenFile
  onChange: (value: string) => void
  onSave: () => void
  onReloadConflict: () => void
  onDismissConflict: () => void
}

function EditorBody({
  file,
  onChange,
  onSave,
  onReloadConflict,
  onDismissConflict,
}: EditorBodyProps) {
  if (file.status === "loading") {
    return <Centered title={`Opening ${file.name}`}>Reading from disk…</Centered>
  }
  if (file.status === "error") {
    return (
      <Centered icon={AlertTriangle} title="Couldn’t open this file">
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
  if (file.isBinary) {
    return (
      <Centered icon={FileImage} title="Binary file">
        This file isn’t text, so it can’t be shown in the editor.
      </Centered>
    )
  }
  if (file.truncated) {
    return (
      <Centered icon={Scaling} title="File too large">
        This file is too big to open here. Use the terminal to work with it.
      </Centered>
    )
  }

  const { label: language } = fileKind(file.name)
  const lineCount = file.content.length ? file.content.split("\n").length : 0

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {file.conflict !== undefined && (
        <div className="flex items-center gap-2 border-b border-border/60 bg-accent/40 px-3 py-1.5 text-xs text-foreground">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
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
      <div className="flex h-8 min-w-0 shrink-0 items-center justify-between gap-3 border-b border-border/60 pl-3 pr-2">
        <Breadcrumb path={file.path} name={file.name} />
        <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
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
            <Save className="h-3.5 w-3.5" />
            {file.saving ? "Saving…" : "Save"}
            {file.dirty && !file.saving && (
              <kbd className="hidden rounded border border-border/60 bg-muted px-1 font-mono text-[10px] leading-tight text-muted-foreground md:inline">
                {SAVE_HINT}
              </kbd>
            )}
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <CodeEditor
          path={file.path}
          value={file.content}
          onChange={onChange}
          onSave={onSave}
        />
      </div>
    </div>
  )
}

/**
 * The active file's path as an accent-tipped breadcrumb: muted folder segments
 * separated by chevrons, then the filename with its type glyph — the header's
 * echo of the "you are here" rail carried by the tree and tabs.
 */
function Breadcrumb({ path, name }: { path: string; name: string }) {
  const segments = path.split("/")
  const folders = segments.slice(0, -1)
  const { Icon: Glyph } = fileKind(name)
  return (
    <nav
      aria-label="File path"
      className="flex min-w-0 items-center gap-1 overflow-hidden font-mono text-xs"
    >
      {folders.map((seg, i) => (
        <span key={i} className="flex shrink-0 items-center gap-1">
          <span className="text-muted-foreground">{seg}</span>
          <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
        </span>
      ))}
      <span className="flex min-w-0 items-center gap-1.5 text-foreground">
        <Glyph className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{name}</span>
      </span>
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
