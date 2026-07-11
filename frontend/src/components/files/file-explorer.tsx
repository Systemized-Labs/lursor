import { useState } from "react"
import { ChevronRight, Folder, FolderOpen } from "lucide-react"

import { useDirectory } from "@/api/files"
import type { DirEntry } from "@/api/files"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

import { fileKind } from "./file-icon"

/** Left indent per tree level; row text starts one step in from the panel edge. */
const INDENT_STEP = 12
const BASE_INDENT = 8

interface FileExplorerProps {
  workspaceId: string
  /** Currently active file path, highlighted in the tree. */
  activePath?: string
  /** Open a file in the editor. */
  onOpenFile: (path: string, name: string) => void
}

/**
 * A lazily-loaded workspace file tree. Directories fetch their children on
 * first expand; the tree refreshes live as the query cache is invalidated by
 * the file watcher. Files open in the editor on click.
 *
 * Depth is drawn with hairline indent guides, and the active file carries a
 * left accent rail — the same "you are here" marker the open tab wears — so
 * the tree, tabs, and header read as one navigation surface.
 */
export function FileExplorer({
  workspaceId,
  activePath,
  onOpenFile,
}: FileExplorerProps) {
  return (
    <div className="flex-1 min-h-0 overflow-auto py-1 text-sm">
      <DirectoryChildren
        workspaceId={workspaceId}
        path=""
        depth={0}
        activePath={activePath}
        onOpenFile={onOpenFile}
      />
    </div>
  )
}

interface ChildrenProps {
  workspaceId: string
  path: string
  depth: number
  activePath?: string
  onOpenFile: (path: string, name: string) => void
}

function DirectoryChildren({
  workspaceId,
  path,
  depth,
  activePath,
  onOpenFile,
}: ChildrenProps) {
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

  return (
    <>
      {sorted.map((entry) => (
        <TreeNode
          key={entry.path}
          workspaceId={workspaceId}
          entry={entry}
          depth={depth}
          activePath={activePath}
          onOpenFile={onOpenFile}
        />
      ))}
    </>
  )
}

interface TreeNodeProps {
  workspaceId: string
  entry: DirEntry
  depth: number
  activePath?: string
  onOpenFile: (path: string, name: string) => void
}

function TreeNode({
  workspaceId,
  entry,
  depth,
  activePath,
  onOpenFile,
}: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false)
  const isActive = !entry.is_dir && entry.path === activePath
  const { Icon: FileGlyph } = fileKind(entry.name)
  const paddingLeft = BASE_INDENT + depth * INDENT_STEP

  return (
    <div>
      <button
        type="button"
        onClick={() =>
          entry.is_dir
            ? setExpanded((v) => !v)
            : onOpenFile(entry.path, entry.name)
        }
        style={{ paddingLeft }}
        aria-expanded={entry.is_dir ? expanded : undefined}
        title={entry.name}
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
            <ChevronRight
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 motion-reduce:transition-none",
                expanded && "rotate-90"
              )}
            />
            {expanded ? (
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
        <span className="truncate">{entry.name}</span>
      </button>

      {entry.is_dir && expanded && (
        <DirectoryChildren
          workspaceId={workspaceId}
          path={entry.path}
          depth={depth + 1}
          activePath={activePath}
          onOpenFile={onOpenFile}
        />
      )}
    </div>
  )
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
