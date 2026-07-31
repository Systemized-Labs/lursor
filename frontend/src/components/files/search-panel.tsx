import { useEffect, useMemo, useState } from "react"
import {
  CaretRight,
  MagnifyingGlass,
  TextAa,
  TextT,
  Warning,
} from "@phosphor-icons/react"

import { ApiError } from "@/api/client"
import { useWorkspaceGrep } from "@/api/files"
import type { GrepMatch, GrepParams } from "@/api/files"
import { Input } from "@/components/ui/input"
import { useDelayed } from "@/hooks/use-delayed"
import { cn } from "@/lib/utils"

import { fileKind } from "./file-icon"

/**
 * How long typing has to settle before a search runs.
 *
 * Deliberately short. The search is a local process — ripgrep answers this
 * workspace in tens of milliseconds — so the debounce, not the search, is what a
 * person feels. Long enough that a word typed at speed is one request rather than
 * eight; short enough that the pause between two words already has results in it.
 */
const DEBOUNCE_MS = 120

/** Matches the backend's default `limit`; shown in the truncation notice. */
const RESULT_LIMIT = 200

interface SearchPanelProps {
  workspaceId: string
  /** Open a result: the file, at the line and column of the match. */
  onOpenMatch: (match: GrepMatch) => void
  /** The file currently on screen, so its rows read as where you are. */
  activePath?: string
}

/**
 * Workspace-wide content search: a query, the three modifier toggles, an optional
 * include glob, and results grouped by file.
 *
 * The whole point is that a result is a place, not a citation — clicking one opens
 * the file *at the line*, which is why `onOpenMatch` carries the position rather
 * than just the path.
 *
 * Read-only: there is no replace-across-files here, and the endpoint behind it has
 * no write side either.
 */
export function SearchPanel({
  workspaceId,
  onOpenMatch,
  activePath,
}: SearchPanelProps) {
  const [query, setQuery] = useState("")
  const [include, setInclude] = useState("")
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)

  // Debounced copies of the two free-text fields. Everything else is a click, so
  // a toggle searches immediately.
  const [settled, setSettled] = useState({ q: "", include: "" })
  useEffect(() => {
    const timer = setTimeout(
      () => setSettled({ q: query, include }),
      DEBOUNCE_MS
    )
    return () => clearTimeout(timer)
  }, [query, include])

  const params: GrepParams = {
    q: settled.q.trim(),
    include: settled.include.trim(),
    case: caseSensitive,
    regex,
    wholeWord,
    limit: RESULT_LIMIT,
  }
  const { data, error, isFetching, isPlaceholderData, refetch } =
    useWorkspaceGrep(workspaceId, params)

  const groups = useMemo(() => groupByFile(data?.matches ?? []), [data])
  const hasQuery = params.q.length > 0
  // Dim the list only once a search has been genuinely slow, and only while there
  // are previous results underneath to dim. A local search normally answers
  // faster than this delay, so the common case never flickers at all — dimming on
  // every keystroke is most of what "slow" actually feels like.
  const stale = useDelayed(hasQuery && isFetching && isPlaceholderData)
  // Same restraint for the first search of all, where there is nothing to dim:
  // "Searching…" that appears for 25ms is worse than a beat of the empty pane.
  const searching = useDelayed(hasQuery && isFetching && !data)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-1.5 border-b border-border/40 px-2 py-2">
        <div className="relative">
          <MagnifyingGlass className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search in files"
            aria-label="Search in files"
            className="h-8 pl-7 text-xs"
          />
        </div>
        {/* The modifiers sit on their own row rather than inside the field, as
            VS Code puts them. This pane is ~190px at its default width, and three
            overlaid buttons plus their reserved padding left less than half of it
            to type in — with the query's own centre underneath a toggle. On their
            own row they still read as belonging to the query above them. */}
        <div className="flex items-center gap-1">
          <div className="flex shrink-0 items-center gap-0.5">
            <Toggle
              pressed={caseSensitive}
              onPressedChange={setCaseSensitive}
              label="Match case"
            >
              <TextAa className="h-3.5 w-3.5" />
            </Toggle>
            <Toggle
              pressed={wholeWord}
              onPressedChange={setWholeWord}
              label="Match whole word"
            >
              <TextT className="h-3.5 w-3.5" />
            </Toggle>
            <Toggle
              pressed={regex}
              onPressedChange={setRegex}
              label="Use regular expression"
            >
              <span className="font-mono text-[11px] leading-none">.*</span>
            </Toggle>
          </div>
          <Input
            value={include}
            onChange={(e) => setInclude(e.target.value)}
            placeholder="Include, e.g. src/**/*.ts"
            aria-label="Files to include"
            className="h-7 min-w-0 flex-1 text-xs"
          />
        </div>
      </div>

      <div
        className={cn(
          // Y only: every row inside is built to fit the width, and a horizontal
          // scrollbar here would mean one of them isn't — better to clip than to
          // let one long name put the whole list on a second axis.
          "min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1 text-sm transition-opacity",
          // Dimmed rather than blanked while refetching: the previous results are
          // still the best thing to show, and a spinner in their place makes the
          // pane flicker on every keystroke.
          stale && "opacity-50"
        )}
      >
        {!hasQuery ? (
          <Hint>
            Search the text of every file in this workspace. Generated folders —
            <code className="px-0.5 font-mono">node_modules</code>,{" "}
            <code className="px-0.5 font-mono">dist</code>,{" "}
            <code className="px-0.5 font-mono">.git</code> — are skipped, as are
            binaries.
          </Hint>
        ) : error ? (
          <div className="px-3 py-2">
            <p className="flex items-start gap-1.5 text-xs text-foreground">
              <Warning className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
              <span>{searchErrorMessage(error)}</span>
            </p>
            <button
              type="button"
              onClick={() => void refetch()}
              className="mt-1.5 rounded px-1.5 py-0.5 text-xs font-medium text-foreground hover:bg-accent"
            >
              Try again
            </button>
          </div>
        ) : groups.length === 0 ? (
          <Hint>
            {searching
              ? "Searching…"
              : isFetching
                ? ""
                : `No results for “${params.q}”.`}
          </Hint>
        ) : (
          groups.map(([path, matches]) => (
            <FileGroup
              key={path}
              path={path}
              matches={matches}
              isActive={path === activePath}
              onOpenMatch={onOpenMatch}
            />
          ))
        )}
      </div>

      {hasQuery && !error && data && (
        <Summary
          matches={data.matches.length}
          files={groups.length}
          truncated={data.truncated}
        />
      )}
    </div>
  )
}

/**
 * What to say when a search fails.
 *
 * A 404 is worth naming specially. The path is one the frontend knows about, so
 * the only way to get one is a backend older than this build — a dev server left
 * running across the change. Reported verbatim it reads as "Not Found", which
 * looks like an empty result and sends you looking for the bug in your query.
 */
function searchErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return "This backend doesn’t have workspace search yet — restart it to pick up the endpoint."
  }
  if (error instanceof ApiError && error.status === 422) {
    return error.message
  }
  return error instanceof Error ? error.message : "The search failed."
}

/** Matches bucketed by file, keeping the order the backend returned them in. */
function groupByFile(matches: GrepMatch[]): [string, GrepMatch[]][] {
  const buckets = new Map<string, GrepMatch[]>()
  for (const match of matches) {
    const bucket = buckets.get(match.path)
    if (bucket) bucket.push(match)
    else buckets.set(match.path, [match])
  }
  return [...buckets]
}

interface FileGroupProps {
  path: string
  matches: GrepMatch[]
  isActive: boolean
  onOpenMatch: (match: GrepMatch) => void
}

/** One file's hits under a collapsible header carrying its count. */
function FileGroup({ path, matches, isActive, onOpenMatch }: FileGroupProps) {
  const [collapsed, setCollapsed] = useState(false)
  const { Icon: Glyph } = fileKind(path)
  const segments = path.split("/")
  const name = segments.pop() ?? path
  // The *immediate* parent, not the whole path. In a ~190px pane a full path
  // truncated to "l…" is noise, while the containing folder is both short enough
  // to fit and the part that actually tells two same-named files apart. The full
  // path is on the row's tooltip either way.
  const folder = segments[segments.length - 1] ?? ""

  return (
    <div>
      <button
        type="button"
        onClick={() => setCollapsed((prev) => !prev)}
        aria-expanded={!collapsed}
        title={path}
        className={cn(
          "group flex w-full items-center gap-1.5 py-1 pl-2 pr-2 text-left outline-none",
          "focus-visible:bg-accent/60",
          isActive
            ? "bg-accent/60 text-foreground"
            : "text-foreground hover:bg-accent/50"
        )}
      >
        <CaretRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 motion-reduce:transition-none",
            !collapsed && "rotate-90"
          )}
        />
        <Glyph className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80" />
        {/* Both of these must be able to shrink, or a long filename widens the row
            past the pane and puts the whole results list on a horizontal scroll.
            The folder carries `flex-1` (so basis 0) and gives way first; the
            filename is the identifier and only truncates once the folder is gone.
            Neither loss matters much — the row's tooltip has the full path. */}
        <span className="min-w-0 truncate text-xs">{name}</span>
        {folder && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {folder}
          </span>
        )}
        <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
          {matches.length}
        </span>
      </button>

      {!collapsed &&
        matches.map((match, i) => (
          <MatchRow
            // Two hits can share a line and column only if the backend repeated
            // itself, so the index keeps the key total.
            key={`${match.line}:${match.column}:${i}`}
            match={match}
            onOpen={() => onOpenMatch(match)}
          />
        ))}
    </div>
  )
}

/**
 * Characters of the line kept in front of the match.
 *
 * The side pane is ~190px at its default width — about twenty monospace
 * characters per line. Keeping a line's whole prefix therefore pushed the *match*
 * off the right edge for anything indented or late in its line, which is a result
 * list that doesn't show you what matched. A short lead puts the highlight within
 * the first few characters and still shows what it sits inside; the row's second
 * line (see below) carries the rest.
 */
const LEAD_CONTEXT_CHARS = 4

/** A single hit: its line number, then the line with the match emphasized. */
function MatchRow({ match, onOpen }: { match: GrepMatch; onOpen: () => void }) {
  // `column` is 1-based and true to the file; `text` may be a window of a long
  // line, so the offset it was cut at is what places the match inside it.
  const start = Math.max(0, match.column - 1 - match.text_offset)
  const end = start + match.match_length
  const text = match.text
  // Drop leading indentation (noise in a one-line row), then anything before the
  // match beyond the lead budget.
  const indent = Math.min(text.length - text.trimStart().length, start)
  const from = Math.max(indent, start - LEAD_CONTEXT_CHARS)
  // An ellipsis whenever something was dropped — here or by the backend's window.
  const clipped = from > 0 || match.text_offset > 0

  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${match.path}:${match.line} — ${text.trim()}`}
      className="flex w-full items-baseline gap-1.5 py-0.5 pl-3 pr-2 text-left font-mono text-[11px] outline-none hover:bg-accent/50 focus-visible:bg-accent/60"
    >
      <span className="w-7 shrink-0 text-right tabular-nums text-muted-foreground/70">
        {match.line}
      </span>
      {/* Up to two lines, wrapping mid-token. One truncated line fits about
          twenty characters here, which is not enough context to tell two hits
          apart; two is. `break-all` because the interesting tokens in code are
          long identifiers with no break opportunity in them. */}
      <span className="line-clamp-2 min-w-0 flex-1 whitespace-pre-wrap break-all text-muted-foreground">
        {clipped && <span className="text-muted-foreground/50">…</span>}
        {text.slice(from, start)}
        <mark className="rounded-sm bg-primary/25 px-0 text-foreground">
          {text.slice(start, end)}
        </mark>
        {text.slice(end)}
      </span>
    </button>
  )
}

/**
 * The count, and — when the search stopped early — the fact that it did. A
 * truncated list that says nothing reads as a complete one, which is the worse
 * failure of the two.
 */
function Summary({
  matches,
  files,
  truncated,
}: {
  matches: number
  files: number
  truncated: boolean
}) {
  return (
    <div className="shrink-0 border-t border-border/40 px-3 py-1.5 text-[11px] text-muted-foreground">
      {matches === 0 ? (
        "No matches"
      ) : (
        <>
          {matches} {matches === 1 ? "match" : "matches"} in {files}{" "}
          {files === 1 ? "file" : "files"}
          {truncated && (
            <span className="block text-muted-foreground/80">
              Stopped at the first {matches} — narrow the query or add an include
              pattern.
            </span>
          )}
        </>
      )}
    </div>
  )
}

/** A small square toggle for one of the query modifiers. */
function Toggle({
  pressed,
  onPressedChange,
  label,
  children,
}: {
  pressed: boolean
  onPressedChange: (pressed: boolean) => void
  label: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      onClick={() => onPressedChange(!pressed)}
      className={cn(
        "flex h-5 w-5 items-center justify-center rounded transition-colors",
        pressed
          ? "bg-accent text-foreground ring-1 ring-primary/40"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
      )}
    >
      {children}
    </button>
  )
}

function Hint({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 py-2 text-xs leading-relaxed text-muted-foreground">
      {children}
    </p>
  )
}
