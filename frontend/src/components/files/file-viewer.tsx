import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { FolderOpen, MagnifyingGlass } from "@phosphor-icons/react"

import { filesApi } from "@/api/files"
import type { FileChange, GrepMatch } from "@/api/files"
import { isPlanFile } from "@/lib/plan-doc"
import { useFileWatch } from "@/hooks/use-file-watch"
import { consumePendingFile, subscribeOpenFile } from "@/lib/open-file"
import { tabStorageKey } from "@/lib/tab-storage"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { cn } from "@/lib/utils"

import { EditorPane } from "./editor-pane"
import { useFileBuffers, type FileSource, type OpenFileOptions } from "./file-buffers"
import { FileExplorer } from "./file-explorer"
import { SearchPanel } from "./search-panel"

/** Persisted flag: is the side pane collapsed out of the viewer? */
const TREE_HIDDEN_STORAGE_KEY = "lursor-file-tree-hidden"

/** Which view the side pane is showing. */
type SideView = "explorer" | "search"

/**
 * Narrowest panel worth splitting into two editors, in CSS pixels. Below this a
 * split produces two unreadable columns, so the control is disabled and says why
 * instead of obliging.
 */
const MIN_SPLIT_WIDTH = 700

interface FileViewerProps {
  workspaceId?: string
  /** Hosting dock tab, when this editor lives in the right dock. */
  tabId?: string
  /** Whether this panel is the one on screen; only it takes pending requests. */
  active?: boolean
  /** Report the open file's name for the tab strip. */
  onDetail?: (tabId: string, detail: string | null) => void
}

/**
 * A lightweight, VS Code-style editor for a workspace: a file tree, workspace-wide
 * content search, multiple open files as tabs (optionally as two groups side by
 * side), and a Monaco editor. A filesystem watcher streams changes so edits made
 * by a running agent appear live — reloading a clean buffer in place, or flagging
 * a conflict when the file changed under unsaved edits.
 *
 * The tabs, buffers and editor itself are the shared {@link EditorPane} /
 * {@link useFileBuffers} pair (also used by the skill editor); what lives here is
 * everything workspace-specific — the tree, search, the watcher, and open-file
 * requests arriving from elsewhere in the app.
 *
 * More than one can be open in the dock at a time (two files side by side), each
 * with its own buffers; only the visible one takes pending open-file requests.
 */
export function FileViewer({
  workspaceId,
  tabId,
  active = true,
  onDetail,
}: FileViewerProps) {
  const qc = useQueryClient()
  const [treeHidden, setTreeHidden] = useState(
    () =>
      typeof localStorage !== "undefined" &&
      localStorage.getItem(TREE_HIDDEN_STORAGE_KEY) === "1"
  )
  // Per *tab*, not per workspace: two Files panels open at once would otherwise
  // fight over which view their side pane shows.
  const [sideView, setSideView] = useTabView(tabId)

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
  const { openFiles, activePath, split, reconcile, isOpen, closeGroup } = buffers

  // Panel width decides whether a split is offered at all — see MIN_SPLIT_WIDTH.
  const [editorArea, editorWidth] = useMeasuredWidth()
  const splitTooNarrow = editorWidth > 0 && editorWidth < MIN_SPLIT_WIDTH

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
    async (path: string, name: string, options?: OpenFileOptions) => {
      // Plan docs open full-width: collapse the side pane on first open. Not
      // persisted — it's a per-session nudge, not a change to the saved
      // preference, and the toggle brings the tree right back.
      if (isPlanFile(name) && !isOpen(path)) setTreeHidden(true)
      await buffers.openFile(path, name, options)
    },
    [buffers, isOpen]
  )

  // A search hit is a place, not just a file: carry the position through so the
  // editor scrolls to the line and selects the match.
  const openMatch = useCallback(
    (match: GrepMatch) => {
      void openFile(match.path, match.path.split("/").pop() ?? match.path, {
        reveal: {
          line: match.line,
          column: match.column,
          length: match.match_length,
        },
      })
    },
    [openFile]
  )

  // Open files requested from elsewhere (e.g. the global command palette). We
  // consume a pending request on mount and whenever a new one is parked, so a
  // freshly-opened file tab or an already-open viewer both react.
  //
  // Only while visible: hidden dock tabs stay mounted, so an unguarded viewer
  // could swallow the request and open the file where nobody can see it. A
  // parked request makes the shell focus a file tab, and that viewer — now
  // active — picks it up.
  useEffect(() => {
    if (!active) return
    const tryOpen = () => {
      const request = consumePendingFile(workspaceId)
      if (!request) return
      void openFile(request.path, request.name, {
        // A request that names a line asks to land on it; one that doesn't just
        // opens the file, exactly as before.
        reveal:
          request.line === undefined
            ? undefined
            : {
                line: request.line,
                column: request.column,
                length: request.length,
              },
      })
    }
    tryOpen()
    return subscribeOpenFile(tryOpen)
  }, [workspaceId, openFile, active])

  // Label the dock tab with the file on screen, so several Files tabs read as
  // the documents they hold rather than as identical chips.
  const activeName = openFiles.find((f) => f.path === activePath)?.name
  useEffect(() => {
    if (!tabId) return
    onDetail?.(tabId, activeName ?? null)
  }, [tabId, onDetail, activeName])

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

  // The side pane can only be hidden once a file is open — with no file open you'd
  // have no way to reach one, so force it visible there regardless of the pref.
  const showSide = openFiles.length === 0 || !treeHidden

  // The sidebar toggle and the close-split control belong on the *rightmost*
  // strip: one is about the pane next to it, the other about folding this group
  // back into the one on its left.
  const editors = (
    <div ref={editorArea} className="flex min-h-0 flex-1 flex-col">
      {split ? (
        <ResizablePanelGroup
          direction="horizontal"
          // Tab-scoped, or two Files panels would share one saved split ratio.
          autoSaveId={`file-viewer-split:${tabId ?? "default"}`}
          className="flex-1 min-h-0"
        >
          <ResizablePanel minSize={25} className="flex min-w-0 flex-col bg-card">
            <EditorPane
              group={0}
              buffers={buffers}
              rawUrl={source?.rawUrl}
              splitEnabled
              splitTooNarrow={splitTooNarrow}
            />
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel minSize={25} className="flex min-w-0 flex-col bg-card">
            <EditorPane
              group={1}
              buffers={buffers}
              rawUrl={source?.rawUrl}
              splitEnabled
              splitTooNarrow={splitTooNarrow}
              sidebarHidden={treeHidden}
              onToggleSidebar={toggleTree}
              onCloseGroup={() => closeGroup(1)}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        // No inner group at all when there's no split, so the panel count doesn't
        // churn as one appears and disappears.
        <EditorPane
          group={0}
          buffers={buffers}
          rawUrl={source?.rawUrl}
          splitEnabled
          splitTooNarrow={splitTooNarrow}
          sidebarHidden={treeHidden}
          onToggleSidebar={toggleTree}
        />
      )}
    </div>
  )

  if (!showSide) {
    return <div className="flex-1 min-h-0 flex flex-col bg-card">{editors}</div>
  }

  return (
    <ResizablePanelGroup
      direction="horizontal"
      autoSaveId="file-viewer-v2"
      className="flex-1 min-h-0"
    >
      <ResizablePanel minSize={30} className="flex flex-col min-w-0 bg-card">
        {editors}
      </ResizablePanel>
      <ResizableHandle />
      {/* A touch wider than a bare file tree would need: this panel also holds the
          search results, whose rows are `line │ text` and want the characters.
          Only a default — an existing saved ratio (`autoSaveId`) still wins. */}
      <ResizablePanel defaultSize={32} minSize={15} className="flex flex-col min-w-0">
        <SideViewSwitch view={sideView} onChange={setSideView} />
        {/* Both views stay mounted: switching preserves tree expansion and the
            search results and query, which is the whole reason to have a switch
            rather than a mode. */}
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col",
            sideView !== "explorer" && "hidden"
          )}
        >
          <FileExplorer
            workspaceId={workspaceId}
            activePath={activePath}
            onOpenFile={(path, name) => void openFile(path, name)}
          />
        </div>
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col",
            sideView !== "search" && "hidden"
          )}
        >
          <SearchPanel
            workspaceId={workspaceId}
            activePath={activePath}
            onOpenMatch={openMatch}
          />
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

/** Explorer / Search, as a two-item segmented control at the side pane's top. */
function SideViewSwitch({
  view,
  onChange,
}: {
  view: SideView
  onChange: (view: SideView) => void
}) {
  const items: { id: SideView; label: string; icon: React.ElementType }[] = [
    { id: "explorer", label: "Explorer", icon: FolderOpen },
    { id: "search", label: "Search", icon: MagnifyingGlass },
  ]
  return (
    <div
      role="tablist"
      aria-label="Side pane view"
      className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border/40 px-1.5"
    >
      {items.map(({ id, label, icon: Icon }) => {
        const isActive = view === id
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(id)}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors",
              isActive
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * The side pane's current view, persisted per dock tab.
 *
 * Keyed by tab id rather than by workspace: a workspace can hold two Files panels,
 * and one showing search while the other shows the tree is a layout, not a
 * conflict.
 */
function useTabView(tabId: string | undefined) {
  const key = tabId ? tabStorageKey(tabId, "side-view") : null
  const [view, setView] = useState<SideView>(() => {
    if (!key || typeof localStorage === "undefined") return "explorer"
    return localStorage.getItem(key) === "search" ? "search" : "explorer"
  })
  const update = useCallback(
    (next: SideView) => {
      setView(next)
      if (key && typeof localStorage !== "undefined") {
        try {
          localStorage.setItem(key, next)
        } catch {
          // Best-effort: a full or disabled store just means it won't persist.
        }
      }
    },
    [key]
  )
  return [view, update] as const
}

/**
 * A ref to attach and the element's live width in CSS pixels (0 until measured).
 *
 * Used to decide whether the panel has room for two editors. A media query can't
 * answer that — the dock is a resizable split, so the panel's width has nothing to
 * do with the viewport's.
 */
function useMeasuredWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return [ref, width] as const
}
