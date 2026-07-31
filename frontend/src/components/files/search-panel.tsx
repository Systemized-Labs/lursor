import { useEffect, useMemo, useState } from "react"
import {
  CaretRight,
  MagnifyingGlass,
  TextAa,
  TextT,
  Warning,
} from "@phosphor-icons/react"

import { useWorkspaceGrep } from "@/api/files"
import type { GrepMatch, GrepParams } from "@/api/files"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

import { fileKind } from "./file-icon"

/**
 * How long typing has to settle before a search runs. Long enough that a word
 * typed at speed is one request rather than eight, short enough that the pause
 * between words already shows results.
 */
const DEBOUNCE_MS = 250

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
  // A query still settling, or one already in flight over stale results — both
  // read as "the list you're looking at isn't the answer yet".
  const stale = hasQuery && (query.trim() !== params.q || isPlaceholderData)

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
            className="h-8 pl-7 pr-[5.25rem] text-xs"
          />
          {/* Inside the field, as in VS Code: the toggles modify this query, and
              putting them anywhere else makes them read as panel settings. */}
          <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
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
        </div>
        <Input
          value={include}
          onChange={(e) => setInclude(e.target.value)}
          placeholder="Files to include, e.g. src/**/*.ts"
          aria-label="Files to include"
          className="h-7 text-xs"
        />
      </div>

      <div
        className={cn(
          "min-h-0 flex-1 overflow-auto py-1 text-sm transition-opacity",
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
              <span>
                {error instanceof Error ? error.message : "The search failed."}
              </span>
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
            {isFetching ? "Searching…" : `No results for “${params.q}”.`}
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
  const name = path.split("/").pop() ?? path
  const folder = path.slice(0, path.length - name.length - 1)

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
        <span className="shrink-0 text-xs">{name}</span>
        {/* The folder takes whatever width is left over. The filename above is
            the identifier; this is context, so it is the part that gives way. */}
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

/** A single hit: its line number, then the line with the match emphasized. */
function MatchRow({ match, onOpen }: { match: GrepMatch; onOpen: () => void }) {
  // `column` is 1-based and true to the file; `text` may be a window of a long
  // line, so the offset it was cut at is what places the match inside it.
  const start = Math.max(0, match.column - 1 - match.text_offset)
  const end = start + match.match_length
  const text = match.text
  // Leading indentation is noise in a one-line result row, but only trimmed when
  // the match itself isn't inside it.
  const trim = Math.min(text.length - text.trimStart().length, start)

  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${match.path}:${match.line}`}
      className="flex w-full items-baseline gap-2 py-0.5 pl-7 pr-2 text-left font-mono text-[11px] outline-none hover:bg-accent/50 focus-visible:bg-accent/60"
    >
      <span className="w-9 shrink-0 text-right tabular-nums text-muted-foreground/70">
        {match.line}
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {text.slice(trim, start)}
        <mark className="rounded-sm bg-primary/25 px-0 text-foreground">
          {text.slice(start, end)}
        </mark>
        {text.slice(end)}
        {match.text_offset > 0 && (
          <span className="text-muted-foreground/50"> …</span>
        )}
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
