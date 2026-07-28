import {
  CaretDown,
  CaretRight,
  MagnifyingGlass,
  WarningCircle,
} from "@phosphor-icons/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type { EnvVar, ResolvedEnvEntry, Workspace } from "@/api/types"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import {
  ENV_SCOPES,
  envScope,
  layerLabel,
  reachLabel,
  standingIn,
  type EnvScope,
  type Standing,
} from "./env-scope"

/** The `Applies in:` filter's off position — Radix rejects an empty item value. */
export const ANYWHERE = "anywhere"

const STORAGE_KEY = "lursor.env-rail.collapsed"

function loadCollapsed(): EnvScope[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return ENV_SCOPES.map((s) => s.key).filter((key) => parsed.includes(key))
  } catch {
    return []
  }
}

/** How a selection was made — an auto-selection must not act like a click. */
export type SelectSource = "pointer" | "keyboard" | "auto"

interface EnvRailProps {
  /** Variables matching the current filters, in any order. */
  envVars: EnvVar[]
  /** Size of the whole set, so the header can say "n of m". */
  total: number
  workspaces: Workspace[]
  workspaceNames: Map<string, string>
  skillNames: Map<string, string>
  skillSlugs: Map<string, string>
  search: string
  onSearchChange: (value: string) => void
  /** A workspace id, or {@link ANYWHERE}. */
  appliesIn: string
  onAppliesInChange: (value: string) => void
  /** The resolver's answer for `appliesIn`, keyed by variable name. */
  resolved: Map<string, ResolvedEnvEntry>
  resolving: boolean
  selectedId: string | undefined
  onSelect: (envVar: EnvVar | undefined, source: SelectSource) => void
  /** Enter or a double click: jump the pane's name field into edit. */
  onActivate: (envVar: EnvVar) => void
}

/**
 * The dense half of the environment browser: one line per variable under a
 * collapsible reach heading, with search and an `Applies in:` filter above.
 *
 * The filter is where the old "Effective environment" card went. Picking a
 * workspace narrows the rail to what a run there actually receives and re-labels
 * every row with the layer it won at — so the resolver stops being a panel you
 * scroll to and becomes the lens you read the list through. A variable that is in
 * scope but loses the key to a closer layer stays visible, struck through, because
 * "why is my value being ignored" is exactly the question this answers.
 *
 * A row carries no controls at all — a state dot, the name, and where it applies.
 * Everything you can *do* lives in the detail pane, which has room to label it.
 */
export function EnvRail({
  envVars,
  total,
  workspaces,
  workspaceNames,
  skillNames,
  skillSlugs,
  search,
  onSearchChange,
  appliesIn,
  onAppliesInChange,
  resolved,
  resolving,
  selectedId,
  onSelect,
  onActivate,
}: EnvRailProps) {
  const [collapsed, setCollapsed] = useState<EnvScope[]>(loadCollapsed)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // A search that matched only inside a collapsed section would look like no
  // match at all, so searching overrides collapse without discarding it.
  const searching = search.trim().length > 0
  const isOpen = useCallback(
    (key: EnvScope) => searching || !collapsed.includes(key),
    [collapsed, searching]
  )

  function toggleSection(key: EnvScope) {
    setCollapsed((prev) => {
      const next = prev.includes(key)
        ? prev.filter((k) => k !== key)
        : [...prev, key]
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch {
        // A rail that can't remember its collapse state still works.
      }
      return next
    })
  }

  const previewing = appliesIn !== ANYWHERE

  const sections = useMemo(
    () =>
      ENV_SCOPES.map((section) => ({
        ...section,
        items: envVars
          .filter((envVar) => envScope(envVar) === section.key)
          .sort((a, b) => a.key.localeCompare(b.key)),
      })).filter((section) => section.items.length > 0),
    [envVars]
  )

  // Rows you can actually arrow onto, in visual order.
  const visible = useMemo(
    () => sections.flatMap((section) => (isOpen(section.key) ? section.items : [])),
    [sections, isOpen]
  )

  // An empty pane beside a full rail is a dead half-screen, so a selection is
  // always held if one can be. When the selected row disappears — deleted,
  // filtered out, collapsed away — the row that took its place inherits it.
  const orderRef = useRef<string[]>([])
  useEffect(() => {
    const ids = visible.map((envVar) => envVar.id)
    const previous = orderRef.current
    orderRef.current = ids
    if (selectedId && ids.includes(selectedId)) return
    if (visible.length === 0) {
      if (selectedId) onSelect(undefined, "auto")
      return
    }
    const wasAt = selectedId ? previous.indexOf(selectedId) : -1
    const index = wasAt >= 0 ? Math.min(wasAt, visible.length - 1) : 0
    onSelect(visible[index], "auto")
  }, [visible, selectedId, onSelect])

  function focusRow(id: string) {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-env-id="${CSS.escape(id)}"]`)
      ?.focus()
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "/") {
      event.preventDefault()
      searchRef.current?.focus()
      searchRef.current?.select()
      return
    }
    if (event.key === "Enter") {
      const current = visible.find((envVar) => envVar.id === selectedId)
      if (current) {
        event.preventDefault()
        onActivate(current)
      }
      return
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    event.preventDefault()
    const at = visible.findIndex((envVar) => envVar.id === selectedId)
    const next =
      at < 0
        ? 0
        : event.key === "ArrowDown"
          ? Math.min(at + 1, visible.length - 1)
          : Math.max(at - 1, 0)
    const envVar = visible[next]
    if (!envVar) return
    onSelect(envVar, "keyboard")
    focusRow(envVar.id)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 border-b border-border/60 p-2">
        <div className="flex h-8 items-center gap-2 rounded-md border border-transparent bg-muted/60 px-2 focus-within:border-ring/40 focus-within:bg-background">
          <MagnifyingGlass className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={(e) => {
              // Straight from typing into the results, without reaching for a mouse.
              if (e.key === "ArrowDown" && visible[0]) {
                e.preventDefault()
                onSelect(visible[0], "keyboard")
                focusRow(visible[0].id)
              }
            }}
            placeholder="Search variables…"
            aria-label="Search variables"
            className="min-w-0 flex-1 bg-transparent font-mono text-xs text-foreground outline-none placeholder:font-sans placeholder:text-muted-foreground"
            spellCheck={false}
          />
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {envVars.length === total ? total : `${envVars.length}/${total}`}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="shrink-0 text-[11px] text-muted-foreground">
            Applies in
          </span>
          <Select value={appliesIn} onValueChange={onAppliesInChange}>
            <SelectTrigger
              className="h-8 min-w-0 flex-1 px-2 text-xs"
              aria-label="Filter by where a variable applies"
              title="Show only what a run in one workspace would actually receive, and which layer each value came from"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-[60vh]">
              <SelectItem value={ANYWHERE}>Anywhere</SelectItem>
              {workspaces.map((ws) => (
                <SelectItem key={ws.id} value={ws.id}>
                  {ws.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Keyboard nav is handled here, on the bubble from the focused row.
          Plain overflow rather than `ScrollArea`, whose viewport sizes to its
          widest child — a long variable name would widen the rail instead of
          truncating inside it. */}
      <div
        ref={listRef}
        onKeyDown={handleKeyDown}
        className="min-h-0 flex-1 overflow-y-auto pb-2"
      >
        {resolving && sections.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            Resolving…
          </p>
        ) : sections.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            {previewing
              ? "Nothing reaches this workspace yet."
              : "No variables match this search."}
          </p>
        ) : (
          sections.map((section) => {
            const open = isOpen(section.key)
            return (
              <div key={section.key}>
                <button
                  type="button"
                  onClick={() => toggleSection(section.key)}
                  aria-expanded={open}
                  title={section.hint}
                  className="sticky top-0 z-10 flex h-7 w-full items-center gap-1 bg-background/95 px-2 text-left outline-none backdrop-blur transition-colors hover:bg-muted/60 focus-visible:ring-1 focus-visible:ring-ring/50"
                >
                  {open ? (
                    <CaretDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                  ) : (
                    <CaretRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {section.title}
                  </span>
                  <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
                    {section.items.length}
                  </span>
                </button>
                {open &&
                  section.items.map((envVar) => (
                    <EnvRailRow
                      key={envVar.id}
                      envVar={envVar}
                      selected={envVar.id === selectedId}
                      reach={reachLabel(envVar, workspaceNames, skillNames)}
                      standing={
                        previewing
                          ? standingIn(
                              envVar,
                              resolved.get(envVar.key),
                              appliesIn,
                              skillSlugs
                            )
                          : null
                      }
                      onSelect={() => onSelect(envVar, "pointer")}
                      onActivate={() => onActivate(envVar)}
                    />
                  ))}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

interface EnvRailRowProps {
  envVar: EnvVar
  selected: boolean
  reach: string
  /** Non-null only while a workspace is being previewed. */
  standing: Standing | null
  onSelect: () => void
  onActivate: () => void
}

function EnvRailRow({
  envVar,
  selected,
  reach,
  standing,
  onSelect,
  onActivate,
}: EnvRailRowProps) {
  // A variable with no value is injected as an empty string, which is the failure
  // mode that actually bites: the skill runs, the API call 401s, and nothing in
  // the UI ever said the key was blank. So it takes the state slot with a
  // different *shape* — it reads as a third state, not a differently-coloured one.
  const empty = !envVar.has_value
  const applies = envScope(envVar) !== "unassigned"
  const stateLabel = empty
    ? "No value set — runs receive it as an empty string"
    : applies
      ? "Live — injected wherever it applies"
      : "Stored, but attached to nothing"

  // While previewing a workspace the right-hand label answers a sharper question
  // than "where does this apply": which layer won, here.
  const shadowed = standing !== null && !standing.winning
  const trailing = standing
    ? standing.winning
      ? layerLabel(standing.layer)
      : `beaten by ${layerLabel(standing.beatenBy ?? "")}`
    : reach

  return (
    <button
      type="button"
      data-env-id={envVar.id}
      onClick={onSelect}
      onDoubleClick={onActivate}
      aria-current={selected}
      title={`${envVar.key} · ${
        standing
          ? standing.winning
            ? `wins at the ${layerLabel(standing.layer)} layer`
            : `set at ${layerLabel(standing.layer)}, overridden by ${layerLabel(standing.beatenBy ?? "")}`
          : reach
      } · ${stateLabel}`}
      className={cn(
        "relative flex h-7 w-full items-center gap-2 pl-3 pr-2 text-left outline-none transition-colors",
        selected
          ? "bg-accent"
          : "hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/50"
      )}
    >
      {/* The same "you are here" marker as the workspace file tree. */}
      {selected && <span className="absolute inset-y-0 left-0 w-0.5 bg-primary" />}
      {empty ? (
        <WarningCircle
          weight="fill"
          role="img"
          aria-label={stateLabel}
          className="h-3 w-3 shrink-0 text-destructive"
        />
      ) : (
        <span
          role="img"
          aria-label={stateLabel}
          className={cn(
            "h-2 w-2 shrink-0 rounded-full border",
            applies
              ? "border-primary bg-primary"
              : "border-muted-foreground/50 bg-transparent"
          )}
        />
      )}
      <span
        className={cn(
          "min-w-0 flex-1 truncate font-mono text-xs",
          shadowed && "line-through",
          applies && !empty && !shadowed
            ? "text-foreground"
            : "text-muted-foreground"
        )}
      >
        {envVar.key}
      </span>
      <span className="max-w-[45%] shrink-0 truncate text-[10px] text-muted-foreground">
        {trailing}
      </span>
    </button>
  )
}
