import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  GitBranch,
  MonitorSmartphone,
  RefreshCw,
} from "lucide-react"

import { fileKind } from "@/components/files/file-icon"
import { useGitDiff, gitKeys, type ChangedFile } from "@/api/git"
import { useFileWatch } from "@/hooks/use-file-watch"
import { parseDiff, type DiffHunk } from "@/lib/parse-diff"
import { cn } from "@/lib/utils"

// Coalesce bursts of edits (an agent can touch dozens of files in a second) into
// a single diff refetch, so we re-query git at most this often while it churns.
const REFRESH_DEBOUNCE_MS = 500

interface ChangesPanelProps {
  /** The workspace whose uncommitted changes are shown. */
  workspaceId?: string
}

/**
 * The right-dock "Changes" panel: a review view of the workspace's uncommitted
 * changes (working tree vs HEAD). Lists every touched file with its add/delete
 * counts and status, and expands each into a syntax-neutral unified-diff view —
 * gaps between hunks collapse to a "N unmodified lines" row, mirroring a
 * Cursor/GitHub diff.
 */
export function ChangesPanel({ workspaceId }: ChangesPanelProps) {
  const { data, isLoading, isError, error, refetch, isFetching } =
    useGitDiff(workspaceId)

  // Auto-refresh: when the workspace's files change on disk (agent edits, saves,
  // git operations), debounce-invalidate the diff so the panel stays live.
  const qc = useQueryClient()
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()
  useFileWatch(
    workspaceId,
    useCallback(() => {
      if (!workspaceId) return
      clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        qc.invalidateQueries({ queryKey: gitKeys.diff(workspaceId) })
      }, REFRESH_DEBOUNCE_MS)
    }, [qc, workspaceId])
  )
  useEffect(() => () => clearTimeout(debounceRef.current), [])

  // A workspace can hold several repos (e.g. a nested `swarmcore-ui/`); show the
  // lone repo's branch, or a repo count when there's more than one.
  const repoCount = data?.repos.length ?? 0
  const branch =
    repoCount > 1 ? `${repoCount} repos` : (data?.branch ?? "—")

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Source / branch header */}
      <div className="flex items-center gap-2 border-b border-border/60 px-2 h-9 shrink-0">
        <span className="flex items-center gap-1.5 rounded-md bg-muted/60 px-2 py-0.5 text-xs text-foreground">
          <MonitorSmartphone className="h-3.5 w-3.5" />
          Local
        </span>
        <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
          <GitBranch className="h-3 w-3 shrink-0" />
          {branch}
        </span>
        <button
          type="button"
          onClick={() => refetch()}
          title="Refresh changes"
          aria-label="Refresh changes"
          className="ml-auto rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-accent shrink-0"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
        </button>
      </div>

      {/* Summary row */}
      <div className="flex items-center gap-2 border-b border-border/60 px-3 h-8 shrink-0">
        <span className="text-xs font-medium text-foreground">Working Changes</span>
        {data && data.is_repo && (
          <span className="ml-auto flex items-center gap-2 font-mono text-xs">
            {data.additions > 0 && (
              <span className="text-success">+{data.additions}</span>
            )}
            {data.deletions > 0 && (
              <span className="text-destructive">-{data.deletions}</span>
            )}
          </span>
        )}
      </div>

      {/* Body */}
      {isLoading ? (
        <div className="flex-1 flex items-center justify-center p-6 text-xs text-muted-foreground">
          Loading changes…
        </div>
      ) : isError ? (
        <div className="flex-1 flex items-center justify-center p-6 text-center text-xs text-destructive">
          {error instanceof Error ? error.message : "Could not load changes."}
        </div>
      ) : !data?.is_repo ? (
        <EmptyState
          title="No git repository"
          hint="No git repo was found in this workspace. Initialize one to review changes here."
        />
      ) : data.files.length === 0 ? (
        <EmptyState
          title="No changes"
          hint="Your working tree matches the last commit."
        />
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto">
          {data.files.map((file) => (
            <FileDiff key={file.path} file={file} />
          ))}
        </div>
      )}
    </div>
  )
}

/** Coarse status → short label + tone shown as a chip on the right. */
const STATUS_META: Record<
  ChangedFile["status"],
  { label: string; className: string } | null
> = {
  added: { label: "New", className: "text-success" },
  deleted: { label: "Deleted", className: "text-destructive" },
  modified: null,
}

/** One expandable file entry: a header row plus its diff hunks. */
function FileDiff({ file }: { file: ChangedFile }) {
  const [open, setOpen] = useState(true)
  const hunks = useMemo(() => parseDiff(file.diff), [file.diff])
  const { Icon } = fileKind(file.path)
  const status = STATUS_META[file.status]

  return (
    <div className="border-b border-border/40">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setOpen((v) => !v)
        }}
        className="group flex items-center gap-1.5 px-2 py-2 cursor-pointer hover:bg-accent/40"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-xs text-foreground" title={file.path}>
          {file.path}
        </span>
        <span className="ml-auto flex items-center gap-2 pl-2 font-mono text-xs">
          {file.additions > 0 && (
            <span className="text-success">+{file.additions}</span>
          )}
          {file.deletions > 0 && (
            <span className="text-destructive">-{file.deletions}</span>
          )}
        </span>
        {status && (
          <span className={cn("shrink-0 text-xs", status.className)}>
            {status.label}
          </span>
        )}
      </div>

      {open && (
        <div className="border-t border-border/40 bg-muted/20">
          {file.is_binary ? (
            <DiffNotice text="Binary file — no preview." />
          ) : file.truncated ? (
            <DiffNotice text="File too large to preview." />
          ) : hunks.length === 0 ? (
            <DiffNotice text="No textual changes." />
          ) : (
            <div className="overflow-x-auto font-mono text-xs leading-5">
              {hunks.map((hunk, i) => (
                <Hunk key={i} hunk={hunk} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** A single diff hunk: an optional collapsed-gap row, then its lines. */
function Hunk({ hunk }: { hunk: DiffHunk }) {
  return (
    <div>
      {hunk.gapBefore > 0 && (
        <div className="flex items-center gap-2 bg-accent/30 px-2 py-1 text-muted-foreground">
          <ChevronsDownUp className="h-3.5 w-3.5" />
          <span>
            {hunk.gapBefore} unmodified line{hunk.gapBefore === 1 ? "" : "s"}
          </span>
        </div>
      )}
      {hunk.lines.map((line, i) => (
        <div
          key={i}
          className={cn(
            "flex whitespace-pre",
            line.type === "add" && "bg-success/10",
            line.type === "del" && "bg-destructive/10"
          )}
        >
          <span
            className={cn(
              "w-10 shrink-0 select-none pr-2 text-right",
              line.type === "add"
                ? "text-success"
                : line.type === "del"
                  ? "text-destructive"
                  : "text-muted-foreground/60"
            )}
          >
            {line.type === "del" ? line.oldNo : line.newNo}
          </span>
          <span
            className={cn(
              "w-4 shrink-0 select-none text-center",
              line.type === "add" && "text-success",
              line.type === "del" && "text-destructive"
            )}
          >
            {line.type === "add" ? "+" : line.type === "del" ? "-" : ""}
          </span>
          <span className="pr-3 text-foreground">{line.content || " "}</span>
        </div>
      ))}
    </div>
  )
}

/** A muted single-line notice for diffs we don't render (binary, oversize…). */
function DiffNotice({ text }: { text: string }) {
  return <div className="px-3 py-2 text-xs text-muted-foreground">{text}</div>
}

/** Centered empty/placeholder state for the panel body. */
function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-1 p-6 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}
