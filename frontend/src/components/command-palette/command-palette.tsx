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
  GitBranch,
  ChatCentered,
  Plug,
  Gear,
  SlidersHorizontal,
  ShootingStar,
  Wrench,
  type Icon,
} from "@phosphor-icons/react"

import { filesApi } from "@/api/files"
import { threadKeys, threadsApi } from "@/api/threads"
import { useWorkspaces } from "@/api/workspaces"
import type { Thread } from "@/api/types"
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog"
import { fileKind } from "@/components/files/file-icon"
import { requestOpenFile } from "@/lib/open-file"
import { cn } from "@/lib/utils"

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
            className="fixed left-1/2 top-[12%] z-50 w-[92vw] max-w-2xl -translate-x-1/2 overflow-hidden rounded-xl border border-border/60 bg-popover text-popover-foreground shadow-2xl duration-150 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
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

type Filter = "all" | "agents" | "files" | "actions"
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "agents", label: "Agents" },
  { key: "files", label: "Files" },
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

/** Compact relative time ("3s" / "5m" / "2h" / "4d"). */
function timeAgo(iso?: string): string {
  if (!iso) return ""
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ""
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d`
  return `${Math.floor(d / 30)}mo`
}

// --- Data hooks -------------------------------------------------------------

interface WorkspaceThread extends Thread {
  workspaceName: string
}

/** Every workspace's conversations, merged and sorted newest-first. */
function useAllThreads() {
  const workspacesQuery = useWorkspaces()
  const workspaces = workspacesQuery.data ?? []

  const results = useQueries({
    queries: workspaces.map((ws) => ({
      queryKey: threadKeys.byWorkspace(ws.id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        threadsApi.listByWorkspace(ws.id, signal),
    })),
  })

  const threads: WorkspaceThread[] = []
  results.forEach((result, i) => {
    const ws = workspaces[i]
    if (!ws) return
    for (const t of result.data ?? []) {
      threads.push({ ...t, workspaceName: ws.name })
    }
  })
  threads.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""))

  return { threads, workspaces }
}

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
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<Filter>("all")
  const [activeIndex, setActiveIndex] = useState(0)
  const debouncedQuery = useDebounced(query)

  const { threads, workspaces } = useAllThreads()
  const files = useAllFiles(debouncedQuery, workspaces)

  const go = useCallback(
    (to: string) => {
      navigate(to)
      onClose()
    },
    [navigate, onClose]
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

  const q = query.trim().toLowerCase()

  const sections = useMemo<Section[]>(() => {
    const agentRows: Row[] = threads
      .filter((t) => !q || (t.title || "Untitled").toLowerCase().includes(q))
      .map((t) => ({
        id: `agent:${t.id}`,
        label: t.title || "Untitled",
        meta: [t.workspaceName, timeAgo(t.updated_at)].filter(Boolean).join("  "),
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

    const actionDefs: {
      label: string
      icon: Icon
      to: string
      meta?: string
    }[] = [
      { label: "Customization", icon: SlidersHorizontal, to: "/customization" },
      { label: "Agents", icon: ShootingStar, to: "/customization?tab=agents" },
      { label: "Skills", icon: SquaresFour, to: "/customization?tab=skills" },
      { label: "Tools", icon: Wrench, to: "/customization?tab=tools" },
      { label: "Settings", icon: Gear, to: "/settings" },
      { label: "Providers", icon: Plug, to: "/settings?tab=providers" },
      { label: "GitHub", icon: GitBranch, to: "/settings?tab=github" },
    ]
    const actionRows: Row[] = actionDefs
      .filter((a) => !q || a.label.toLowerCase().includes(q))
      .map((a) => ({
        id: `action:${a.to}`,
        label: a.label,
        meta: a.meta,
        icon: a.icon,
        onSelect: () => go(a.to),
      }))

    const searching = q.length > 0
    // In "all", cap each section; a focused filter shows the full list.
    const cap = (rows: Row[]) => (filter === "all" ? rows.slice(0, LIMIT_ALL) : rows)

    const all: Section[] = [
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
      { key: "actions", title: "Actions", rows: cap(actionRows) },
    ]

    return all.filter(
      (s) => (filter === "all" || filter === s.key) && s.rows.length > 0
    )
  }, [threads, files, q, filter, go, openFile])

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
        placeholder="Search agents, files, actions..."
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

      <div className="max-h-[52vh] overflow-y-auto py-2">
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

      <div className="flex items-center gap-4 border-t border-border/60 px-4 py-2.5 text-xs text-muted-foreground">
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
