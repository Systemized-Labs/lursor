import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  CaretDown,
  CaretRight,
  ArrowsInLineVertical,
  ArrowsIn,
  ArrowsOut,
  GitBranch,
  Devices,
  ArrowsClockwise,
} from "@phosphor-icons/react"

import { fileKind } from "@/components/files/file-icon"
import { useGitDiff, gitKeys, type ChangedFile } from "@/api/git"
import { useFileWatch } from "@/hooks/use-file-watch"
import { useGitWatch } from "@/hooks/use-git-watch"
import { parseDiff, type DiffLine, type DiffHunk } from "@/lib/parse-diff"
import { highlightLine, langFromPath, type Token } from "@/lib/syntax-highlight"
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
 * counts and status, and expands each into a syntax-highlighted, word-level
 * unified-diff view — gaps between hunks collapse to a "N unmodified lines"
 * row, mirroring a Cursor/GitHub diff.
 */
export function ChangesPanel({ workspaceId }: ChangesPanelProps) {
  const { data, isLoading, isError, error, refetch, isFetching } =
    useGitDiff(workspaceId)

  // Auto-refresh: debounce-invalidate the diff so the panel stays live without a
  // manual refresh. Two sockets feed it — the files watcher (working-tree edits:
  // agent saves, manual edits) and the git watcher (state changes the files
  // watcher can't see because it ignores `.git/`: commits, staging, branch
  // switches, merges/rebases/resets). Both funnel through one debounce so a burst
  // of edits followed by a commit re-queries git at most once per window.
  const qc = useQueryClient()
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const scheduleRefresh = useCallback(() => {
    if (!workspaceId) return
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      qc.invalidateQueries({ queryKey: gitKeys.diff(workspaceId) })
    }, REFRESH_DEBOUNCE_MS)
  }, [qc, workspaceId])
  useFileWatch(workspaceId, scheduleRefresh)
  useGitWatch(workspaceId, scheduleRefresh)
  useEffect(() => () => clearTimeout(debounceRef.current), [])

  const files = data?.files
  // Per-file expand state, keyed by path. We track the paths the user has
  // *expanded* (rather than collapsed) so every file starts collapsed by
  // default — the panel opens as a scannable file list with no flash of fully
  // expanded diffs on first paint. The set survives the panel's frequent
  // auto-refetches, so a user's expansions persist while new files stay
  // collapsed.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  const toggleFile = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])
  const expandAll = useCallback(
    () => setExpanded(new Set((files ?? []).map((f) => f.path))),
    [files]
  )
  const collapseAll = useCallback(() => setExpanded(new Set()), [])

  // A workspace can hold several repos (e.g. a nested `swarmcore-ui/`); show the
  // lone repo's branch, or a repo count when there's more than one.
  const repoCount = data?.repos.length ?? 0
  const branch = repoCount > 1 ? `${repoCount} repos` : (data?.branch ?? "—")
  const fileCount = files?.length ?? 0

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Source / branch header */}
      <div className="flex items-center gap-2 border-b border-border/40 px-2 h-9 shrink-0">
        <span className="flex items-center gap-1.5 rounded-md bg-muted/60 px-2 py-0.5 text-xs text-foreground">
          <Devices className="h-3.5 w-3.5" />
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
          <ArrowsClockwise className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
        </button>
      </div>

      {/* Summary / toolbar row */}
      <div className="flex items-center gap-2 border-b border-border/40 px-3 h-8 shrink-0">
        <span className="text-xs font-medium text-foreground">Working Changes</span>
        {fileCount > 0 && (
          <span className="text-xs text-muted-foreground">
            {fileCount} file{fileCount === 1 ? "" : "s"}
          </span>
        )}
        {data && data.is_repo && (
          <span className="ml-auto flex items-center gap-2.5 font-mono text-xs">
            {data.additions > 0 && (
              <span className="text-success">+{data.additions}</span>
            )}
            {data.deletions > 0 && (
              <span className="text-destructive">-{data.deletions}</span>
            )}
          </span>
        )}
        {fileCount > 0 && (
          <span className={cn("flex items-center gap-0.5", !(data && data.is_repo) && "ml-auto")}>
            <button
              type="button"
              onClick={collapseAll}
              title="Collapse all files"
              aria-label="Collapse all files"
              className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-accent"
            >
              <ArrowsIn className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={expandAll}
              title="Expand all files"
              aria-label="Expand all files"
              className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-accent"
            >
              <ArrowsOut className="h-3.5 w-3.5" />
            </button>
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
            <FileDiff
              key={file.path}
              file={file}
              open={expanded.has(file.path)}
              onToggle={toggleFile}
            />
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

/** One expandable file entry: a sticky header row plus its diff hunks. */
function FileDiff({
  file,
  open,
  onToggle,
}: {
  file: ChangedFile
  open: boolean
  onToggle: (path: string) => void
}) {
  const hunks = useMemo(() => parseDiff(file.diff), [file.diff])
  const lang = useMemo(() => langFromPath(file.path), [file.path])
  const { Icon } = fileKind(file.path)
  const status = STATUS_META[file.status]
  // Split the path so the filename reads boldest and the directory sits muted
  // beside it — easier to scan a long list than a single truncated string.
  const slash = file.path.lastIndexOf("/")
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : ""
  const name = slash >= 0 ? file.path.slice(slash + 1) : file.path

  return (
    <div className="border-b border-border/40">
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => onToggle(file.path)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            onToggle(file.path)
          }
        }}
        className="group sticky top-0 z-10 flex items-center gap-1.5 border-b border-border/40 bg-background px-2 py-2 cursor-pointer hover:bg-accent/40"
      >
        {open ? (
          <CaretDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <CaretRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 items-baseline gap-1 truncate text-xs" title={file.path}>
          {dir && <span className="truncate text-muted-foreground/70">{dir}</span>}
          <span className="text-foreground">{name}</span>
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
        <div className="bg-muted/20">
          {file.is_binary ? (
            <DiffNotice text="Binary file — no preview." />
          ) : file.truncated ? (
            <DiffNotice text="File too large to preview." />
          ) : hunks.length === 0 ? (
            <DiffNotice text="No textual changes." />
          ) : (
            <div className="overflow-x-auto font-mono text-xs leading-5">
              {hunks.map((hunk, i) => (
                <Hunk key={i} hunk={hunk} lang={lang} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** A single diff hunk: an optional collapsed-gap row, then its lines. */
function Hunk({ hunk, lang }: { hunk: DiffHunk; lang: string | null }) {
  return (
    <div>
      {hunk.gapBefore > 0 && (
        <div className="flex items-center gap-2 bg-accent/30 px-2 py-1 text-muted-foreground">
          <ArrowsInLineVertical className="h-3.5 w-3.5" />
          <span>
            {hunk.gapBefore} unmodified line{hunk.gapBefore === 1 ? "" : "s"}
          </span>
        </div>
      )}
      {hunk.lines.map((line, i) => (
        <DiffLineRow key={i} line={line} lang={lang} />
      ))}
    </div>
  )
}

/** One diff line: accent bar, dual old|new gutter, marker, highlighted code. */
function DiffLineRow({ line, lang }: { line: DiffLine; lang: string | null }) {
  const tokens = useMemo(
    () => highlightLine(line.content, lang),
    [line.content, lang]
  )
  const isAdd = line.type === "add"
  const isDel = line.type === "del"

  return (
    <div
      className={cn(
        "flex",
        isAdd && "bg-success/10",
        isDel && "bg-destructive/10"
      )}
    >
      {/* Colored accent bar anchors the eye to changed rows. */}
      <span
        className={cn(
          "w-0.5 shrink-0",
          isAdd && "bg-success",
          isDel && "bg-destructive"
        )}
      />
      <span className="w-8 shrink-0 select-none pr-1.5 text-right tabular-nums text-muted-foreground/50">
        {line.oldNo ?? ""}
      </span>
      <span className="w-8 shrink-0 select-none pr-1.5 text-right tabular-nums text-muted-foreground/50">
        {line.newNo ?? ""}
      </span>
      <span
        className={cn(
          "w-3.5 shrink-0 select-none text-center",
          isAdd && "text-success",
          isDel && "text-destructive"
        )}
      >
        {isAdd ? "+" : isDel ? "-" : ""}
      </span>
      <code className="hljs flex-1 whitespace-pre bg-transparent pr-3">
        {renderTokens(tokens, line)}
      </code>
    </div>
  )
}

/**
 * Render a highlighted line, overlaying word-level emphasis. Syntax tokens are
 * split at the line's changed character ranges so each output span keeps its
 * `hljs-*` colour while changed slices also get a stronger background.
 */
function renderTokens(tokens: Token[], line: DiffLine): ReactNode {
  const changed = line.changed
  if (!changed || changed.length === 0) {
    return tokens.map((t, i) => (
      <span key={i} className={t.className}>
        {t.text || (i === 0 ? " " : "")}
      </span>
    ))
  }

  const emphasis =
    line.type === "add"
      ? "rounded-[3px] bg-success/30"
      : "rounded-[3px] bg-destructive/30"
  const out: ReactNode[] = []
  let key = 0
  let pos = 0
  for (const token of tokens) {
    const tStart = pos
    const tEnd = pos + token.text.length
    let cursor = tStart
    for (const range of changed) {
      if (range.end <= cursor || range.start >= tEnd) continue
      const from = Math.max(cursor, range.start)
      const to = Math.min(tEnd, range.end)
      if (from > cursor) {
        out.push(
          <span key={key++} className={token.className}>
            {token.text.slice(cursor - tStart, from - tStart)}
          </span>
        )
      }
      out.push(
        <span key={key++} className={cn(token.className, emphasis)}>
          {token.text.slice(from - tStart, to - tStart)}
        </span>
      )
      cursor = to
    }
    if (cursor < tEnd) {
      out.push(
        <span key={key++} className={token.className}>
          {token.text.slice(cursor - tStart)}
        </span>
      )
    }
    pos = tEnd
  }
  return out
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
