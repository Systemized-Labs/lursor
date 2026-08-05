import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ElementType,
  type ReactNode,
} from "react"
import { useNavigate } from "react-router-dom"
import { useQueries } from "@tanstack/react-query"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import {
  SquaresFour,
  ArrowElbowDownLeft,
  ChartBar,
  Clock,
  Cpu,
  FilmSlate,
  FolderOpen,
  GitBranch,
  ChatCentered,
  ImageSquare,
  Keyboard,
  Palette,
  Plug,
  Gear,
  SlidersHorizontal,
  ShootingStar,
  Sparkle,
  Terminal,
  Wrench,
  type Icon,
} from "@phosphor-icons/react"

import { filesApi } from "@/api/files"
import { useSkills } from "@/api/skills"
import type { Skill, Workspace } from "@/api/types"
import { useAllThreads } from "@/hooks/use-all-threads"
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog"
import { fileKind } from "@/components/files/file-icon"
import { useSettingsParam } from "@/components/settings/use-settings-param"
import { requestOpenFile } from "@/lib/open-file"
import {
  revealSkill,
  skillLocation,
  skillSourceLabel,
  type SkillLocation,
} from "@/lib/skill-location"
import { timeAgo } from "@/lib/time-ago"
import { cn } from "@/lib/utils"
import { mruOrder, readVisits, resumeHref } from "@/lib/workspace-resume"

// --- Public API -------------------------------------------------------------

interface CommandPaletteContextValue {
  open: () => void
}

const CommandPaletteContext = createContext<CommandPaletteContextValue | null>(
  null
)

/** Open the global command palette from anywhere inside the shell. */
export function useCommandPalette(): CommandPaletteContextValue {
  const ctx = useContext(CommandPaletteContext)
  if (!ctx) {
    throw new Error(
      "useCommandPalette must be used within a CommandPaletteProvider"
    )
  }
  return ctx
}

/**
 * Hosts the global search / command palette and its ⌘K (Ctrl+K) shortcut.
 * Wrap the app shell in this so any child (e.g. the sidebar "Search" item) can
 * pop the palette via {@link useCommandPalette}.
 */
export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setIsOpen((prev) => !prev)
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [])

  const value = useMemo<CommandPaletteContextValue>(
    () => ({ open: () => setIsOpen(true) }),
    []
  )

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogPortal>
          <DialogOverlay />
          <DialogPrimitive.Content
            className="fixed left-1/2 top-[6%] z-50 w-[94vw] max-w-2xl -translate-x-1/2 overflow-hidden rounded-xl border border-border/60 bg-popover text-popover-foreground shadow-2xl duration-150 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:top-[12%] sm:w-[92vw]"
            aria-label="Search"
          >
            <DialogTitle className="sr-only">Search</DialogTitle>
            {/* Mount the body (and its queries) only while open. */}
            {isOpen && <PaletteBody onClose={() => setIsOpen(false)} />}
          </DialogPrimitive.Content>
        </DialogPortal>
      </Dialog>
    </CommandPaletteContext.Provider>
  )
}

// --- Filters ----------------------------------------------------------------

type Filter = "all" | "workspaces" | "agents" | "files" | "skills" | "actions"
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "workspaces", label: "Workspaces" },
  { key: "agents", label: "Agents" },
  { key: "files", label: "Files" },
  { key: "skills", label: "Skills" },
  { key: "actions", label: "Actions" },
]

// --- Result rows ------------------------------------------------------------

interface Row {
  id: string
  label: string
  sublabel?: string
  /** Right-aligned muted metadata (workspace name, timestamp, shortcut). */
  meta?: string
  icon: ElementType
  onSelect: () => void
}

interface Section {
  key: Filter
  title: string
  rows: Row[]
}

const LIMIT_ALL = 5

// --- Data hooks -------------------------------------------------------------

interface WorkspaceFile {
  workspaceId: string
  workspaceName: string
  path: string
  name: string
  /** Containing directory (or workspace name at the root) for disambiguation. */
  sublabel: string
}

/** Fuzzy file search across every workspace tree (server-side per workspace). */
function useAllFiles(
  query: string,
  workspaces: { id: string; name: string }[]
) {
  const results = useQueries({
    queries: workspaces.map((ws) => ({
      queryKey: ["palette-files", ws.id, query],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        filesApi.search(ws.id, query, 8, signal),
    })),
  })

  const files: WorkspaceFile[] = []
  results.forEach((result, i) => {
    const ws = workspaces[i]
    if (!ws) return
    for (const entry of result.data ?? []) {
      if (entry.is_dir) continue
      const slash = entry.path.lastIndexOf("/")
      files.push({
        workspaceId: ws.id,
        workspaceName: ws.name,
        path: entry.path,
        name: entry.name,
        sublabel: slash === -1 ? ws.name : entry.path.slice(0, slash),
      })
    }
  })
  return files
}

/** Debounce a value so file queries don't fire on every keystroke. */
function useDebounced<T>(value: T, delay = 150): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(id)
  }, [value, delay])
  return debounced
}

// --- Palette body -----------------------------------------------------------

function PaletteBody({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const { openSettings } = useSettingsParam()
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<Filter>("all")
  const [activeIndex, setActiveIndex] = useState(0)
  const debouncedQuery = useDebounced(query)

  const { threads, workspaces, allWorkspaces, byWorkspace, workspaceName } =
    useAllThreads()
  const files = useAllFiles(debouncedQuery, workspaces)
  const skills = useSkills().data ?? []
  // Read once per open rather than through the stateful hook: the palette is
  // mounted only while it is showing, so this is always fresh, and a second
  // subscriber would mean a second copy of the record writing to the same key.
  const visits = useMemo(() => readVisits(), [])

  const go = useCallback(
    (to: string) => {
      navigate(to)
      onClose()
    },
    [navigate, onClose]
  )

  /** Open the settings dialog at a category, without leaving this route. */
  const goSettings = useCallback(
    (category: string) => {
      openSettings(category)
      onClose()
    },
    [openSettings, onClose]
  )

  // Selecting a file: park the request, then land on its workspace chat. The
  // shell opens the dock + a file tab and the editor consumes the request.
  const openFile = useCallback(
    (file: WorkspaceFile) => {
      requestOpenFile({
        workspaceId: file.workspaceId,
        path: file.path,
        name: file.name,
      })
      go(`/workspaces/${file.workspaceId}/chat`)
    },
    [go]
  )

  // Selecting a skill: same trick as a file, aimed at its SKILL.md — the
  // catalog workspace for a managed skill, the owning repo for a local one.
  const openSkill = useCallback(
    (location: NonNullable<ReturnType<typeof skillLocation>>) => {
      go(revealSkill(location))
    },
    [go]
  )

  const q = query.trim().toLowerCase()

  const sections = useMemo<Section[]>(() => {
    // Workspaces first: with the rail capped at what fits 68px, this is how the
    // tenth workspace is reached, and how any of them is reached by name rather
    // than by remembering which tile it is. Most-recent-first — unlike the rail,
    // nothing here is navigated by position, so recency is simply more useful.
    const workspaceRows: Row[] = mruOrder(visits)
      .map((id) => allWorkspaces.find((ws) => ws.id === id))
      .concat(
        // Then everything never visited, in rail order, so a brand-new workspace
        // is still findable here.
        allWorkspaces.filter((ws) => !(ws.id in visits))
      )
      .filter((ws): ws is Workspace => Boolean(ws))
      .filter((ws) => !q || ws.name.toLowerCase().includes(q))
      .map((ws) => {
        const wsThreads = byWorkspace.get(ws.id) ?? []
        return {
          id: `workspace:${ws.id}`,
          label: ws.name,
          meta: [
            wsThreads.length
              ? `${wsThreads.length} conversation${wsThreads.length > 1 ? "s" : ""}`
              : null,
            wsThreads[0] ? timeAgo(wsThreads[0].updated_at) : null,
          ]
            .filter(Boolean)
            .join("  "),
          icon: ws.is_system ? Sparkle : FolderOpen,
          // The same resume rule the rail uses, so reaching a workspace by name
          // lands exactly where clicking its tile would.
          onSelect: () => go(resumeHref(ws.id, wsThreads, visits)),
        }
      })

    const agentRows: Row[] = threads
      .filter((t) => !q || (t.title || "Untitled").toLowerCase().includes(q))
      .map((t) => ({
        id: `agent:${t.id}`,
        label: t.title || "Untitled",
        meta: [workspaceName(t.workspace_id), timeAgo(t.updated_at)]
          .filter(Boolean)
          .join("  "),
        icon: ChatCentered,
        onSelect: () => go(`/workspaces/${t.workspace_id}/chat?c=${t.id}`),
      }))

    const fileRows: Row[] = files.map((f) => ({
      id: `file:${f.workspaceId}:${f.path}`,
      label: f.name,
      sublabel: f.sublabel,
      icon: fileKind(f.name).Icon,
      onSelect: () => openFile(f),
    }))

    // Every skill, deep-linked to its own SKILL.md. Reaching a skill's files
    // was three clicks through Customization; here it is the name you already
    // know. Skipped when nothing can open it (a local skill with no workspace,
    // or one in a personal folder that belongs to no workspace at all).
    const skillRows: Row[] = skills
      .filter((s) => !q || s.name.toLowerCase().includes(q) || s.slug.includes(q))
      // `allWorkspaces`, not `workspaces`: a managed skill lives in the studio,
      // and resolving it means finding the `is_system` row — which the filtered
      // list has already removed, so every managed skill silently resolved to
      // null and dropped out of search entirely.
      .map((s) => ({ skill: s, location: skillLocation(s, allWorkspaces) }))
      .filter(
        (entry): entry is { skill: Skill; location: SkillLocation } =>
          entry.location !== null
      )
      .map(({ skill, location }) => ({
        id: `skill:${skill.id}`,
        label: skill.name,
        sublabel: skill.description || undefined,
        // Whose files these are, not merely whether they're in a repo — now that
        // most of the catalog is linked from other tools, "not in a repo" stopped
        // narrowing anything down.
        meta: skillSourceLabel(skill),
        icon: Sparkle,
        onSelect: () => openSkill(location),
      }))

    // No "Skill Studio" row here any more — the studio is a workspace, so it is in
    // the Workspaces section above, where it resumes like every other one instead
    // of always opening a blank composer.
    // Two kinds of destination now: a route, or a category of the settings
    // dialog. Everything that used to be `/settings?tab=` or `/customization?tab=`
    // is the second kind — the palette should still name it, but selecting it
    // opens the dialog over wherever you are rather than navigating away.
    const actionDefs: {
      label: string
      icon: Icon
      to?: string
      settings?: string
      meta?: string
    }[] = [
      { label: "Schedules", icon: Clock, settings: "schedules", meta: "cron jobs" },
      { label: "LAIOS", icon: Cpu, settings: "laios" },
      { label: "Video", icon: FilmSlate, to: "/video", meta: "generate a clip" },
      {
        label: "Image",
        icon: ImageSquare,
        to: "/image",
        meta: "generate an image",
      },
      { label: "Usage", icon: ChartBar, to: "/analytics" },
      {
        label: "Customization",
        icon: SlidersHorizontal,
        settings: "capabilities",
      },
      { label: "Agents", icon: ShootingStar, settings: "capabilities" },
      { label: "Skills", icon: SquaresFour, settings: "capabilities" },
      { label: "Tools", icon: Wrench, settings: "capabilities" },
      { label: "Settings", icon: Gear, settings: "model" },
      { label: "Appearance", icon: Palette, settings: "appearance" },
      { label: "Providers", icon: Plug, settings: "providers" },
      { label: "Environment", icon: Terminal, settings: "environment" },
      { label: "Keyboard shortcuts", icon: Keyboard, settings: "shortcuts" },
      { label: "GitHub", icon: GitBranch, settings: "github" },
    ]
    const actionRows: Row[] = actionDefs
      .filter((a) => !q || a.label.toLowerCase().includes(q))
      .map((a) => ({
        id: `action:${a.settings ? `settings:${a.label}` : a.to}`,
        label: a.label,
        meta: a.meta,
        icon: a.icon,
        onSelect: () =>
          a.settings ? goSettings(a.settings) : a.to ? go(a.to) : undefined,
      }))

    const searching = q.length > 0
    // In "all", cap each section; a focused filter shows the full list.
    const cap = (rows: Row[]) => (filter === "all" ? rows.slice(0, LIMIT_ALL) : rows)

    const all: Section[] = [
      {
        key: "workspaces",
        title: searching ? "Workspaces" : "Recent Workspaces",
        rows: cap(workspaceRows),
      },
      {
        key: "agents",
        title: searching ? "Agents" : "Recent Agents",
        rows: cap(agentRows),
      },
      {
        key: "files",
        title: searching ? "Files" : "Recent Files",
        rows: cap(fileRows),
      },
      { key: "skills", title: "Skills", rows: cap(skillRows) },
      { key: "actions", title: "Actions", rows: cap(actionRows) },
    ]

    return all.filter(
      (s) => (filter === "all" || filter === s.key) && s.rows.length > 0
    )
  }, [
    threads,
    workspaceName,
    files,
    skills,
    allWorkspaces,
    byWorkspace,
    visits,
    q,
    filter,
    go,
    goSettings,
    openFile,
    openSkill,
  ])

  // Flattened rows drive keyboard navigation across every visible section.
  const flatRows = useMemo(() => sections.flatMap((s) => s.rows), [sections])

  // Keep the active row valid as results change.
  useEffect(() => {
    setActiveIndex((i) => (i >= flatRows.length ? 0 : i))
  }, [flatRows.length])
  useEffect(() => {
    setActiveIndex(0)
  }, [debouncedQuery, filter])

  const activeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" })
  }, [activeIndex])

  const cycleFilter = (dir: 1 | -1) => {
    const idx = FILTERS.findIndex((f) => f.key === filter)
    const next = (idx + dir + FILTERS.length) % FILTERS.length
    setFilter(FILTERS[next].key)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      if (flatRows.length) setActiveIndex((i) => (i + 1) % flatRows.length)
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      if (flatRows.length)
        setActiveIndex((i) => (i - 1 + flatRows.length) % flatRows.length)
    } else if (e.key === "Enter") {
      e.preventDefault()
      flatRows[activeIndex]?.onSelect()
    } else if ((e.metaKey || e.ctrlKey) && (e.key === "]" || e.key === "[")) {
      e.preventDefault()
      cycleFilter(e.key === "]" ? 1 : -1)
    }
  }

  let rowIndex = -1

  return (
    <div onKeyDown={onKeyDown}>
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search workspaces, agents, files..."
        className="w-full border-b border-border/60 bg-transparent px-4 py-4 text-base text-foreground outline-none placeholder:text-muted-foreground"
      />

      <div className="flex items-center gap-1 border-b border-border/60 px-3 py-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={cn(
              "rounded-full px-3 py-1 text-sm transition-colors",
              filter === f.key
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="max-h-[65dvh] overflow-y-auto py-2 sm:max-h-[52vh]">
        {flatRows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">
            No matches
          </p>
        ) : (
          sections.map((section) => (
            <div key={section.key} className="mb-1">
              <p className="px-4 pb-1 pt-2 text-xs font-medium text-muted-foreground">
                {section.title}
              </p>
              {section.rows.map((row) => {
                rowIndex += 1
                const isActive = rowIndex === activeIndex
                const Icon = row.icon
                const idx = rowIndex
                return (
                  <button
                    key={row.id}
                    ref={isActive ? activeRef : undefined}
                    type="button"
                    onMouseMove={() => setActiveIndex(idx)}
                    onClick={row.onSelect}
                    className={cn(
                      "flex w-full items-center gap-3 px-4 py-2.5 text-left",
                      isActive ? "bg-accent" : "hover:bg-muted/60"
                    )}
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate text-sm text-foreground">
                      {row.label}
                    </span>
                    {row.sublabel && (
                      <span className="max-w-[35%] shrink-0 truncate text-xs text-muted-foreground">
                        {row.sublabel}
                      </span>
                    )}
                    {row.meta && (
                      <span className="shrink-0 whitespace-pre text-xs tabular-nums text-muted-foreground">
                        {row.meta}
                      </span>
                    )}
                    {isActive && (
                      <ArrowElbowDownLeft className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                  </button>
                )
              })}
            </div>
          ))
        )}
      </div>

      {/* Keyboard hints are meaningless on touch — hide them on phones. */}
      <div className="hidden items-center gap-4 border-t border-border/60 px-4 py-2.5 text-xs text-muted-foreground sm:flex">
        <span className="flex items-center gap-1">
          <kbd className="font-sans">↑↓</kbd> Select
        </span>
        <span className="flex items-center gap-1">
          <kbd className="font-sans">⏎</kbd> Open
        </span>
        <span className="flex items-center gap-1">
          <kbd className="font-sans">⌘[ or ⌘]</kbd> Change Filter
        </span>
      </div>
    </div>
  )
}
