import { useCallback, useEffect, useMemo, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"

import { filesApi } from "@/api/files"
import type { FileChange } from "@/api/files"
import { isPlanFile } from "@/lib/plan-doc"
import { useFileWatch } from "@/hooks/use-file-watch"
import { consumePendingFile, subscribeOpenFile } from "@/lib/open-file"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"

import { EditorPane } from "./editor-pane"
import { useFileBuffers, type FileSource } from "./file-buffers"
import { FileExplorer } from "./file-explorer"

/** Persisted flag: is the file tree collapsed out of the viewer? */
const TREE_HIDDEN_STORAGE_KEY = "lursor-file-tree-hidden"

interface FileViewerProps {
  workspaceId?: string
}

/**
 * A lightweight, VS Code-style editor for a workspace: a file tree, multiple
 * open files as tabs, and a Monaco editor. A filesystem watcher streams changes
 * so edits made by a running agent appear live — reloading a clean buffer in
 * place, or flagging a conflict when the file changed under unsaved edits.
 *
 * The tabs, buffers and editor itself are the shared {@link EditorPane} /
 * {@link useFileBuffers} pair (also used by the skill editor); what lives here is
 * everything workspace-specific — the tree, the watcher, and open-file requests
 * arriving from elsewhere in the app.
 */
export function FileViewer({ workspaceId }: FileViewerProps) {
  const qc = useQueryClient()
  const [treeHidden, setTreeHidden] = useState(
    () =>
      typeof localStorage !== "undefined" &&
      localStorage.getItem(TREE_HIDDEN_STORAGE_KEY) === "1"
  )

  const source = useMemo<FileSource | undefined>(
    () =>
      workspaceId
        ? {
            read: (path) => filesApi.read(workspaceId, path),
            write: async (path, content) => {
              await filesApi.write(workspaceId, path, content)
            },
            rawUrl: (path) => filesApi.rawUrl(workspaceId, path),
          }
        : undefined,
    [workspaceId]
  )
  const buffers = useFileBuffers(source)
  const { openFiles, activePath, reconcile, isOpen } = buffers

  const toggleTree = useCallback(() => {
    setTreeHidden((prev) => {
      const next = !prev
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(TREE_HIDDEN_STORAGE_KEY, next ? "1" : "0")
      }
      return next
    })
  }, [])

  const openFile = useCallback(
    async (path: string, name: string) => {
      // Plan docs open full-width: collapse the tree on first open. Not
      // persisted — it's a per-session nudge, not a change to the saved
      // preference, and the toggle brings the tree right back.
      if (isPlanFile(name) && !isOpen(path)) setTreeHidden(true)
      await buffers.openFile(path, name)
    },
    [buffers, isOpen]
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

  useFileWatch(
    workspaceId,
    useCallback(
      (changes: FileChange[]) => {
        // Refresh the tree (adds/removes/renames) regardless of open files.
        qc.invalidateQueries({ queryKey: ["files", workspaceId, "dir"] })
        // Reconcile the last change per open file.
        const latest = new Map<string, FileChange["type"]>()
        for (const c of changes) {
          if (isOpen(c.path)) latest.set(c.path, c.type)
        }
        for (const [path, type] of latest) void reconcile(path, type)
      },
      [workspaceId, qc, reconcile, isOpen]
    )
  )

  if (!workspaceId) {
    return (
      <div className="flex-1 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Open a workspace to browse its files.
      </div>
    )
  }

  // The tree can only be hidden once a file is open — with no file open you'd
  // have no way to reach one, so force it visible there regardless of the pref.
  const showTree = openFiles.length === 0 || !treeHidden

  const editorPane = (
    <EditorPane
      buffers={buffers}
      rawUrl={source?.rawUrl}
      sidebarHidden={treeHidden}
      onToggleSidebar={toggleTree}
    />
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
