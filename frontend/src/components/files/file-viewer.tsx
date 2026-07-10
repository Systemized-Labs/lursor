import { useCallback, useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, FileX, Save, X } from "lucide-react"
import { toast } from "sonner"

import { fileWatchWsUrl, filesApi } from "@/api/files"
import type { FileChange } from "@/api/files"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { cn } from "@/lib/utils"

import { CodeEditor } from "./code-editor"
import { FileExplorer } from "./file-explorer"

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
      let exists = false
      setOpenFiles((prev) => {
        exists = prev.some((f) => f.path === path)
        if (exists) return prev
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
      if (exists || !workspaceId) return
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

  useEffect(() => {
    if (!workspaceId) return
    let socket: WebSocket | null = null
    let reconnect: ReturnType<typeof setTimeout> | undefined
    let closed = false
    // Exponential backoff so a socket that fails immediately (e.g. no workspace
    // directory) doesn't reconnect in a tight loop. A connection that survives a
    // while resets the delay, so genuine drops still recover quickly.
    let delay = 1000
    const MAX_DELAY = 30000

    const connect = () => {
      const openedAt = Date.now()
      socket = new WebSocket(fileWatchWsUrl(workspaceId))
      socket.onmessage = (event) => {
        let batch: { changes?: FileChange[] }
        try {
          batch = JSON.parse(event.data as string)
        } catch {
          return
        }
        const changes = batch.changes ?? []
        if (changes.length === 0) return
        // Refresh the tree (adds/removes/renames) regardless of open files.
        qc.invalidateQueries({ queryKey: ["files", workspaceId, "dir"] })
        // Reconcile the last change per open file.
        const latest = new Map<string, FileChange["type"]>()
        for (const c of changes) {
          if (openPathsRef.current.has(c.path)) latest.set(c.path, c.type)
        }
        for (const [path, type] of latest) reconcile(path, type)
      }
      socket.onclose = () => {
        if (closed) return
        // Lasted a while → treat as a transient drop and recover fast; failed
        // fast → back off (capped).
        if (Date.now() - openedAt > 10000) delay = 1000
        reconnect = setTimeout(connect, delay)
        delay = Math.min(delay * 2, MAX_DELAY)
      }
    }
    connect()

    return () => {
      closed = true
      if (reconnect) clearTimeout(reconnect)
      socket?.close()
    }
  }, [workspaceId, qc, reconcile])

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
        <div className="flex h-8 shrink-0 items-center px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Explorer
        </div>
        <FileExplorer
          workspaceId={workspaceId}
          activePath={activePath}
          onOpenFile={openFile}
        />
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel minSize={30} className="flex flex-col min-w-0">
        {openFiles.length === 0 ? (
          <div className="flex-1 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
            Select a file to open.
          </div>
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
  return (
    <div className="flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border px-1">
      {files.map((f) => {
        const isActive = f.path === activePath
        return (
          <div
            key={f.path}
            role="tab"
            aria-selected={isActive}
            tabIndex={0}
            onClick={() => onActivate(f.path)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onActivate(f.path)
            }}
            title={f.path}
            className={cn(
              "group flex items-center gap-1.5 rounded-md px-2 py-1 text-xs whitespace-nowrap cursor-pointer",
              isActive
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            )}
          >
            <span>{f.name}</span>
            {f.dirty ? (
              <span
                className="h-1.5 w-1.5 rounded-full bg-foreground/70"
                aria-label="Unsaved changes"
              />
            ) : null}
            <span
              role="button"
              aria-label={`Close ${f.name}`}
              onClick={(e) => {
                e.stopPropagation()
                onClose(f.path)
              }}
              className="ml-0.5 rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-background/60"
            >
              <X className="h-3 w-3" />
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
    return <Centered>Loading {file.name}…</Centered>
  }
  if (file.status === "error") {
    return <Centered>{file.error ?? "Failed to open file."}</Centered>
  }
  if (file.status === "deleted") {
    return (
      <Centered>
        <FileX className="mb-2 h-6 w-6" />
        This file was deleted on disk.
      </Centered>
    )
  }
  if (file.isBinary) {
    return <Centered>Binary file — not shown.</Centered>
  }
  if (file.truncated) {
    return <Centered>File is too large to open in the editor.</Centered>
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {file.conflict !== undefined && (
        <div className="flex items-center gap-2 border-b border-border bg-accent/40 px-3 py-1.5 text-xs text-foreground">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="flex-1">
            Changed on disk while you had unsaved edits.
          </span>
          <button
            type="button"
            onClick={onReloadConflict}
            className="rounded px-1.5 py-0.5 font-medium hover:bg-background/60"
          >
            Reload
          </button>
          <button
            type="button"
            onClick={onDismissConflict}
            className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-background/60 hover:text-foreground"
          >
            Keep mine
          </button>
        </div>
      )}
      <div className="flex h-7 shrink-0 items-center justify-between border-b border-border px-3 text-xs text-muted-foreground">
        <span className="truncate font-mono">{file.path}</span>
        <button
          type="button"
          onClick={onSave}
          disabled={!file.dirty || file.saving}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
          title="Save (Ctrl/Cmd+S)"
        >
          <Save className="h-3.5 w-3.5" />
          {file.saving ? "Saving…" : "Save"}
        </button>
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

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}
