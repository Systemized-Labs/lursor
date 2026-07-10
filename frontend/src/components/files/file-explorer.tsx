import { useState } from "react"
import { ChevronDown, ChevronRight, File, Folder, FolderOpen } from "lucide-react"

import { useDirectory } from "@/api/files"
import type { DirEntry } from "@/api/files"
import { cn } from "@/lib/utils"

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
    return <Hint depth={depth}>Loading…</Hint>
  }
  if (isError) {
    return <Hint depth={depth}>Failed to load</Hint>
  }
  if (!data || data.length === 0) {
    return depth === 0 ? <Hint depth={depth}>Empty folder</Hint> : null
  }

  return (
    <>
      {data.map((entry) => (
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
  // Indent by depth; the base padding keeps text off the panel edge.
  const paddingLeft = 8 + depth * 12

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
        className={cn(
          "flex w-full items-center gap-1.5 py-1 pr-2 text-left",
          isActive
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
        )}
      >
        {entry.is_dir ? (
          <>
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 shrink-0" />
            )}
            {expanded ? (
              <FolderOpen className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <Folder className="h-3.5 w-3.5 shrink-0" />
            )}
          </>
        ) : (
          <File className="ml-[1.125rem] h-3.5 w-3.5 shrink-0" />
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

function Hint({ depth, children }: { depth: number; children: React.ReactNode }) {
  return (
    <p
      className="py-1 text-xs text-muted-foreground"
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      {children}
    </p>
  )
}
