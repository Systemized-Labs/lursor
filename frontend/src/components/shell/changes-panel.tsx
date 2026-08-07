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
  ArrowUp,
  Check,
  CircleNotch,
} from "@phosphor-icons/react"
import { toast } from "sonner"

import { fileKind } from "@/components/files/file-icon"
import {
  useBranches,
  useCheckoutBranch,
  useCommitAndPush,
  useGitDiff,
  gitKeys,
  type ChangedFile,
  type RepoCommitResult,
} from "@/api/git"
import { useFileWatch } from "@/hooks/use-file-watch"
import { useGitWatch } from "@/hooks/use-git-watch"
import { parseDiff, type DiffLine, type DiffHunk } from "@/lib/parse-diff"
import { highlightLine, langFromPath, type Token } from "@/lib/syntax-highlight"
import { requestSendToChat } from "@/lib/send-to-chat"
import { cn } from "@/lib/utils"

// Coalesce bursts of edits (an agent can touch dozens of files in a second) into
// a single diff refetch, so we re-query git at most this often while it churns.
const REFRESH_DEBOUNCE_MS = 500

interface ChangesPanelProps {
  /** The workspace whose uncommitted changes are shown. */
  workspaceId?: string
}

/**
 * The "Changes" pane: a review view of the workspace's uncommitted
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
      // The header branch label and its picker read the branches query, which a
      // branch switch (e.g. one made in a terminal outside the app) changes just
      // as much as the diff — keep it in the same refresh so the label can't lag.
      qc.invalidateQueries({ queryKey: gitKeys.branches(workspaceId) })
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

  // Per-group collapse state for the directory headers, keyed by the top-level
  // segment. Mirror of the per-file set, inverted: groups start *expanded*, so we
  // track the ones the user collapsed. It too survives the auto-refetches, which
  // keep the panel's grouping stable while new files arrive.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => new Set()
  )
  const toggleGroup = useCallback((dir: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(dir)) next.delete(dir)
      else next.add(dir)
      return next
    })
  }, [])

  // Scan grouping: files at the repo root list first, ungrouped; everything
  // else folds under its top-level directory, groups sorted by name.
  const { rootFiles, groups } = useMemo(() => {
    const rootFiles: ChangedFile[] = []
    const byDir = new Map<string, ChangedFile[]>()
    for (const file of files ?? []) {
      const slash = file.path.indexOf("/")
      if (slash === -1) {
        rootFiles.push(file)
      } else {
        const dir = file.path.slice(0, slash)
        const existing = byDir.get(dir)
        if (existing) existing.push(file)
        else byDir.set(dir, [file])
      }
    }
    const groups = [...byDir.entries()]
      .sort(([a], [b]) => a.toLowerCase().localeCompare(b.toLowerCase()))
      .map(([dir, dirFiles]) => ({ dir, files: dirFiles }))
    return { rootFiles, groups }
  }, [files])

  // A workspace can hold several repos (e.g. a nested `swarmcore-ui/`); show the
  // lone repo's branch as a picker, or a repo count when there's more than one
  // (a picker can't check out "the primary of several" without lying about it).
  const repoCount = data?.repos.length ?? 0
  const singleRepo = data?.is_repo === true && repoCount === 1
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
        {singleRepo && workspaceId ? (
          <BranchPicker workspaceId={workspaceId} />
        ) : (
          // Inert label when a picker can't apply (multi-repo or not a repo).
          <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
            <GitBranch className="h-3 w-3 shrink-0" />
            {branch}
          </span>
        )}
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
          {rootFiles.map((file) => (
            <FileDiff
              key={file.path}
              file={file}
              open={expanded.has(file.path)}
              onToggle={toggleFile}
            />
          ))}
          {groups.map((group) => (
            <DirectoryGroup
              key={group.dir}
              dir={group.dir}
              files={group.files}
              collapsed={collapsedGroups.has(group.dir)}
              onToggle={toggleGroup}
              expanded={expanded}
              onToggleFile={toggleFile}
            />
          ))}
        </div>
      )}

      {/* Commit & push box — only when there's something to commit. */}
      {data?.is_repo && fileCount > 0 && workspaceId && (
        <CommitBox workspaceId={workspaceId} />
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
          {/* Thin add/delete ratio bar, proportional to this file's numbers —
              a flat muted bar for binary files (nothing counted). */}
          <span
            className="flex h-1 w-10 shrink-0 overflow-hidden rounded-full bg-muted"
            title={`+${file.additions} / -${file.deletions}`}
          >
            {file.additions + file.deletions > 0 && (
              <>
                <span className="bg-success" style={{ flexGrow: file.additions }} />
                <span
                  className="bg-destructive"
                  style={{ flexGrow: file.deletions }}
                />
              </>
            )}
          </span>
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


/**
 * The header's branch label as a working picker: click for the primary repo's
 * branches (local first, then remote-only), pick one to check it out. A compact
 * inline dropdown — the h-9 panel header can't host the New Agent page's
 * searchable `BranchSelector` and its styling.
 */
function BranchPicker({ workspaceId }: { workspaceId: string }) {
  const branchesQuery = useBranches(workspaceId)
  const checkout = useCheckoutBranch(workspaceId)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const branches = branchesQuery.data?.branches ?? []
  const current = branchesQuery.data?.current ?? null

  // Close on outside click / Escape — the BranchSelector pattern.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  async function selectBranch(name: string) {
    setOpen(false)
    if (name === current) return
    try {
      // The hook invalidates branches + diff on success, so the rest of the
      // panel (label, file list) refreshes itself.
      await checkout.mutateAsync(name)
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : `Failed to switch to ${name}`
      )
    }
  }

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={checkout.isPending}
        title="Switch branch"
        className="flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        <GitBranch className="h-3 w-3 shrink-0" />
        <span className="max-w-[10rem] truncate">{current ?? "—"}</span>
        <CaretDown
          className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-64 w-56 overflow-y-auto rounded-md border border-border/60 bg-popover py-1 shadow-lg">
          {branchesQuery.isLoading ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</p>
          ) : branches.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              No branches.
            </p>
          ) : (
            branches.map((b) => {
              const isCurrent = !b.remote && b.name === current
              return (
                <button
                  key={b.remote ? `${b.remote}/${b.name}` : b.name}
                  type="button"
                  onClick={() => void selectBranch(b.name)}
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs text-foreground hover:bg-accent"
                >
                  <span className="flex-1 truncate">
                    {b.remote ? (
                      <>
                        <span className="text-muted-foreground">{b.remote}/</span>
                        {b.name}
                      </>
                    ) : (
                      b.name
                    )}
                  </span>
                  {isCurrent && (
                    <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />
                  )}
                </button>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}

/** A collapsible top-level-directory group of changed files. */
function DirectoryGroup({
  dir,
  files,
  collapsed,
  onToggle,
  expanded,
  onToggleFile,
}: {
  dir: string
  files: ChangedFile[]
  collapsed: boolean
  onToggle: (dir: string) => void
  expanded: Set<string>
  onToggleFile: (path: string) => void
}) {
  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        onClick={() => onToggle(dir)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            onToggle(dir)
          }
        }}
        className="flex items-center gap-1.5 border-b border-border/40 bg-muted/30 px-2 py-1.5 cursor-pointer hover:bg-accent/40"
      >
        {collapsed ? (
          <CaretRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <CaretDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate text-xs font-medium text-foreground">{dir}/</span>
        <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 py-px font-mono text-[10px] text-muted-foreground">
          {files.length}
        </span>
      </div>
      {!collapsed &&
        files.map((file) => (
          <FileDiff
            key={file.path}
            file={file}
            open={expanded.has(file.path)}
            onToggle={onToggleFile}
          />
        ))}
    </div>
  )
}

/**
 * The panel footer's commit box: one click — the backend stages everything in
 * every repo with changes (a workspace can hold several repos in
 * subdirectories, and a commit can't span repositories, so each dirty repo
 * gets its own commit), the agent composes each message from that repo's
 * staged diff, the commits are made and pushed, and the result lands as a
 * summary in the open chat pane (which the shell focuses on the parked
 * request). A failed push keeps the commit — the summary says so, and the
 * toast is a success, not an error.
 *
 * Deliberately *no message input*: composing the message is the agent's job —
 * that is the point of the button.
 */
function CommitBox({ workspaceId }: { workspaceId: string }) {
  const commitPush = useCommitAndPush(workspaceId)
  const busy = commitPush.isPending

  async function submit() {
    if (busy) return
    try {
      const result = await commitPush.mutateAsync({})
      requestSendToChat({ workspaceId, text: commitSummary(result.commits) })
      toast.success("Committed — summary sent to chat")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Commit failed")
    }
  }

  return (
    <div className="shrink-0 border-t border-border/40 px-2 py-2">
      <button
        type="button"
        onClick={() => void submit()}
        disabled={busy}
        title="Stage everything, have the agent write the commit message, commit and push"
        className="flex h-7 w-full items-center justify-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
      >
        {busy ? (
          <CircleNotch className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <ArrowUp className="h-3.5 w-3.5" />
        )}
        {busy ? "Composing & committing…" : "Commit & Push"}
      </button>
    </div>
  )
}

/** The chat-ready summary of a commit-push: what landed, where, and whether
 *  the push made it. One commit repos reads as a single sentence; a workspace
 *  with several dirty repos reads as a bullet list — one line per repo, so a
 *  failed push on one is unmistakable. */
function commitSummary(commits: RepoCommitResult[]): string {
  const stats = (c: RepoCommitResult) =>
    `${c.files_changed} file${c.files_changed === 1 ? "" : "s"}, +${c.additions}/-${c.deletions}`

  // git's push-failure stderr rambles into usage hints — the first line
  // ("fatal: No configured push destination…") is the part worth putting in chat.
  const firstLine = (text: string | null) => (text ?? "").split("\n", 1)[0]
  if (commits.length === 1) {
    const c = commits[0]
    const where = c.repo === "" ? `\`${c.branch}\`` : `\`${c.repo}\` @ \`${c.branch}\``
    return c.pushed
      ? `📦 Committed and pushed ${c.commit_hash} to ${where}: ${c.message} (${stats(c)})`
      : `⚠️ Committed ${c.commit_hash} on ${where}: ${c.message} — push failed: ${firstLine(c.push_error)} (${stats(c)})`
  }

  const failed = commits.filter((c) => !c.pushed).length
  const header =
    failed === 0
      ? `📦 Committed and pushed ${commits.length} repos:`
      : `⚠️ Committed ${commits.length} repos (${failed} push${failed === 1 ? "" : "es"} failed):`
  const lines = commits.map((c) => {
    const where = c.repo === "" ? "root repo" : `\`${c.repo}\``
    const pushNote = c.pushed ? "" : ` — push failed: ${firstLine(c.push_error)}`
    return `• ${where} @ \`${c.branch}\` ${c.commit_hash}: ${c.message} (${stats(c)})${pushNote}`
  })
  return [header, ...lines].join("\n")
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
