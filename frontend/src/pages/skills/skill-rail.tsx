import { CaretDown, CaretRight, MagnifyingGlass } from "@phosphor-icons/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type { Skill, SkillOrigin, Workspace } from "@/api/types"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

/** The `Applies in:` filter's off position — Radix rejects an empty item value. */
export const ANYWHERE = "anywhere"

/**
 * Would an agent started in this workspace load this skill? The question the
 * page could not previously ask, answered from the list data alone: global
 * skills, skills assigned to the workspace, the repo's own skills, and every
 * personal-folder skill (which apply everywhere by definition).
 */
export function appliesInWorkspace(skill: Skill, workspaceId: string): boolean {
  if (skill.origin === "external") return true
  if (skill.origin === "local") return skill.workspace_id === workspaceId
  return skill.is_global || skill.workspace_ids.includes(workspaceId)
}

/**
 * Sections are by *source*, not by reach. Reach is editable from the detail
 * pane, and a row that jumped to another section the moment you re-pointed it
 * would tear down the control you were using. Where the files live only changes
 * when you explicitly Move or Copy.
 */
const SECTIONS: { key: SkillOrigin; title: string; hint: string }[] = [
  {
    key: "managed",
    title: "Catalog",
    hint: "Yours. One copy, pointed at whatever should load it.",
  },
  {
    key: "local",
    title: "In repos",
    hint: "Committed into a repo — travels with the code and applies only there.",
  },
  {
    key: "external",
    title: "Other tools",
    hint: "Found in your personal skills folders and read where they are. Claude Code or Cursor still owns the files.",
  },
]

const STORAGE_KEY = "lursor.skills-rail.collapsed"

// "Other tools" is the biggest section and the least actionable — those files
// belong to another tool. The count on the header says it is still there.
const DEFAULT_COLLAPSED: SkillOrigin[] = ["external"]

function loadCollapsed(): SkillOrigin[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_COLLAPSED
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return DEFAULT_COLLAPSED
    return SECTIONS.map((s) => s.key).filter((key) => parsed.includes(key))
  } catch {
    return DEFAULT_COLLAPSED
  }
}

/** Where a skill applies, in the space of a rail row. */
function reachLabel(skill: Skill, workspaceNames: Map<string, string>): string {
  if (skill.origin === "external") return skill.root_label || "Other tool"
  if (skill.origin === "local")
    return workspaceNames.get(skill.workspace_id ?? "") ?? "Unknown workspace"
  if (skill.is_global) return "Everywhere"
  const [first, ...rest] = skill.workspace_ids
  if (!first) return "Not assigned"
  if (rest.length === 0) return workspaceNames.get(first) ?? "1 workspace"
  return `${skill.workspace_ids.length} workspaces`
}

/** How a selection was made — an auto-selection must not act like a click. */
export type SelectSource = "pointer" | "keyboard" | "auto"

interface SkillRailProps {
  /** Skills matching the current filters, in any order. */
  skills: Skill[]
  /** Size of the whole catalog, so the header can say "n of m". */
  total: number
  workspaces: Workspace[]
  workspaceNames: Map<string, string>
  search: string
  onSearchChange: (value: string) => void
  /** A workspace id, or {@link ANYWHERE}. */
  appliesIn: string
  onAppliesInChange: (value: string) => void
  selectedId: string | undefined
  onSelect: (skill: Skill | undefined, source: SelectSource) => void
  /** Enter or a double click: hand off to the file editor. */
  onActivate: (skill: Skill) => void
}

/**
 * The dense half of the skills browser: one line per skill under a collapsible
 * source heading, with search and an `Applies in:` filter above.
 *
 * A row carries no controls at all — a state dot, the name, and where it
 * applies. Everything you can *do* to a skill lives in the detail pane, which
 * has room to label it. Selection follows focus, so arrowing down the rail
 * streams detail panes.
 */
export function SkillRail({
  skills,
  total,
  workspaces,
  workspaceNames,
  search,
  onSearchChange,
  appliesIn,
  onAppliesInChange,
  selectedId,
  onSelect,
  onActivate,
}: SkillRailProps) {
  const [collapsed, setCollapsed] = useState<SkillOrigin[]>(loadCollapsed)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // A search that matched only inside a collapsed section would look like no
  // match at all, so searching overrides collapse without discarding it.
  const searching = search.trim().length > 0
  const isOpen = useCallback(
    (key: SkillOrigin) => searching || !collapsed.includes(key),
    [collapsed, searching]
  )

  function toggleSection(key: SkillOrigin) {
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

  const sections = useMemo(
    () =>
      SECTIONS.map((section) => ({
        ...section,
        items: skills
          .filter((skill) => skill.origin === section.key)
          .sort((a, b) => a.name.localeCompare(b.name)),
      })).filter((section) => section.items.length > 0),
    [skills]
  )

  // Rows you can actually arrow onto, in visual order.
  const visible = useMemo(
    () => sections.flatMap((section) => (isOpen(section.key) ? section.items : [])),
    [sections, isOpen]
  )

  // An empty pane beside a full rail is a dead half-screen, so a selection is
  // always held if one can be. When the selected row disappears — deleted,
  // filtered out, collapsed away — the row that took its place inherits it,
  // which for a delete is the next row in the same section.
  const orderRef = useRef<string[]>([])
  useEffect(() => {
    const ids = visible.map((skill) => skill.id)
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
      ?.querySelector<HTMLElement>(`[data-skill-id="${CSS.escape(id)}"]`)
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
      const current = visible.find((skill) => skill.id === selectedId)
      if (current) {
        event.preventDefault()
        onActivate(current)
      }
      return
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    event.preventDefault()
    const at = visible.findIndex((skill) => skill.id === selectedId)
    const next =
      at < 0
        ? 0
        : event.key === "ArrowDown"
          ? Math.min(at + 1, visible.length - 1)
          : Math.max(at - 1, 0)
    const skill = visible[next]
    if (!skill) return
    onSelect(skill, "keyboard")
    focusRow(skill.id)
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
            placeholder="Search skills…"
            aria-label="Search skills"
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {skills.length === total ? total : `${skills.length}/${total}`}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="shrink-0 text-[11px] text-muted-foreground">
            Applies in
          </span>
          <Select value={appliesIn} onValueChange={onAppliesInChange}>
            <SelectTrigger
              className="h-8 min-w-0 flex-1 px-2 text-xs"
              aria-label="Filter by where a skill applies"
              title="Show only what an agent running in one workspace would load"
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
          widest child — a long skill name would widen the rail instead of
          truncating inside it. */}
      <div
        ref={listRef}
        onKeyDown={handleKeyDown}
        className="min-h-0 flex-1 overflow-y-auto pb-2"
      >
        {sections.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-muted-foreground">
            No skills match these filters.
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
                  section.items.map((skill) => (
                    <SkillRailRow
                      key={skill.id}
                      skill={skill}
                      selected={skill.id === selectedId}
                      reach={reachLabel(skill, workspaceNames)}
                      onSelect={() => onSelect(skill, "pointer")}
                      onActivate={() => onActivate(skill)}
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

interface SkillRailRowProps {
  skill: Skill
  selected: boolean
  reach: string
  onSelect: () => void
  onActivate: () => void
}

function SkillRailRow({
  skill,
  selected,
  reach,
  onSelect,
  onActivate,
}: SkillRailRowProps) {
  const stateLabel = skill.enabled
    ? "On — loaded by agents in scope"
    : "Off — kept, but loaded by nothing"

  return (
    <button
      type="button"
      data-skill-id={skill.id}
      onClick={onSelect}
      onDoubleClick={onActivate}
      aria-current={selected}
      title={`${skill.name} · ${reach} · ${stateLabel}`}
      className={cn(
        "relative flex h-7 w-full items-center gap-2 pl-3 pr-2 text-left outline-none transition-colors",
        selected
          ? "bg-accent"
          : "hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/50"
      )}
    >
      {/* The same "you are here" marker as the workspace file tree. */}
      {selected && <span className="absolute inset-y-0 left-0 w-0.5 bg-primary" />}
      {/* Filled vs hollow, not colour: the only cue for on/off in the rail. */}
      <span
        role="img"
        aria-label={stateLabel}
        title={stateLabel}
        className={cn(
          "h-2 w-2 shrink-0 rounded-full border",
          skill.enabled
            ? "border-primary bg-primary"
            : "border-muted-foreground/50 bg-transparent"
        )}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-xs",
          skill.enabled ? "text-foreground" : "text-muted-foreground"
        )}
      >
        {skill.name}
      </span>
      <span className="max-w-[45%] shrink-0 truncate text-[10px] text-muted-foreground">
        {reach}
      </span>
    </button>
  )
}
