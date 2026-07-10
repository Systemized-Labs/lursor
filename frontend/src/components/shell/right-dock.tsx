import { useState } from "react"
import { useLocation } from "react-router-dom"
import {
  Activity,
  FileCode,
  Globe,
  Plus,
  Terminal as TerminalIcon,
  PanelRightClose,
  X,
} from "lucide-react"
import type { ElementType } from "react"

import { TerminalPanel } from "@/components/shell/terminal-panel"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

/** Panel kinds the dock can host. Placeholders until real content is wired up. */
export type DockKind = "file" | "preview" | "terminal" | "activity"

const DOCK_KINDS: DockKind[] = ["file", "preview", "terminal", "activity"]

const TAB_META: Record<DockKind, { title: string; icon: ElementType }> = {
  file: { title: "Files", icon: FileCode },
  preview: { title: "Preview", icon: Globe },
  terminal: { title: "Terminal", icon: TerminalIcon },
  activity: { title: "Activity", icon: Activity },
}

interface DockTab {
  id: string
  kind: DockKind
}

let tabSeq = 0
const nextTabId = () => `dock-tab-${++tabSeq}`

interface RightDockProps {
  /** Collapse the dock (shell hides it and offers a re-open affordance). */
  onCollapse: () => void
}

/**
 * The right-side, editor-style panel dock — the Cursor "agent view" right pane.
 *
 * Hosts closeable tabs with a `+` menu and an empty state of panel cards. Panel
 * bodies are placeholders for now; each kind will host real content (file tree,
 * preview, terminal, activity) as those features land.
 */
export function RightDock({ onCollapse }: RightDockProps) {
  const [tabs, setTabs] = useState<DockTab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  // The active workspace (from `/workspaces/:id/...`) roots dock content like
  // the terminal in that workspace's directory.
  const { pathname } = useLocation()
  const workspaceId = pathname.match(/\/workspaces\/([^/]+)/)?.[1]

  function openTab(kind: DockKind) {
    const tab: DockTab = { id: nextTabId(), kind }
    setTabs((prev) => [...prev, tab])
    setActiveId(tab.id)
  }

  function closeTab(id: string) {
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id)
      setActiveId((cur) =>
        cur === id ? next[next.length - 1]?.id ?? null : cur
      )
      return next
    })
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 border-l border-border bg-background">
      {/* Tab strip */}
      <div className="flex items-center gap-1 border-b border-border px-1.5 h-9 shrink-0">
        <div className="flex-1 flex items-center gap-0.5 overflow-x-auto">
          {tabs.map((t) => {
            const Icon = TAB_META[t.kind].icon
            const isActive = t.id === activeId
            return (
              <div
                key={t.id}
                role="tab"
                aria-selected={isActive}
                tabIndex={0}
                onClick={() => setActiveId(t.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") setActiveId(t.id)
                }}
                className={cn(
                  "group flex items-center gap-1.5 rounded-md px-2 py-1 text-xs whitespace-nowrap cursor-pointer",
                  isActive
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{TAB_META[t.kind].title}</span>
                <span
                  role="button"
                  aria-label={`Close ${TAB_META[t.kind].title}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(t.id)
                  }}
                  className="ml-0.5 rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-background/60"
                >
                  <X className="h-3 w-3" />
                </span>
              </div>
            )
          })}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title="Add panel"
              aria-label="Add panel"
              className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-accent shrink-0"
            >
              <Plus className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Panels</DropdownMenuLabel>
              {DOCK_KINDS.map((kind) => {
                const Icon = TAB_META[kind].icon
                return (
                  <DropdownMenuItem key={kind} onClick={() => openTab(kind)}>
                    <Icon className="h-4 w-4" />
                    <span>{TAB_META[kind].title}</span>
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <button
          type="button"
          onClick={onCollapse}
          title="Hide panel"
          aria-label="Hide panel"
          className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-accent shrink-0"
        >
          <PanelRightClose className="h-4 w-4" />
        </button>
      </div>

      {/* Body: all open panels mounted, inactive ones hidden */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {tabs.length === 0 ? (
          <DockEmptyState onOpen={openTab} />
        ) : (
          tabs.map((t) => (
            <div
              key={t.id}
              className={cn(
                "flex-1 min-h-0 flex flex-col",
                t.id !== activeId && "hidden"
              )}
            >
              <DockPanelContent kind={t.kind} workspaceId={workspaceId} />
            </div>
          ))
        )}
      </div>
    </div>
  )
}

/** Panel body: real content where wired up, a placeholder otherwise. */
function DockPanelContent({
  kind,
  workspaceId,
}: {
  kind: DockKind
  workspaceId?: string
}) {
  if (kind === "terminal") {
    return <TerminalPanel workspaceId={workspaceId} />
  }

  const meta = TAB_META[kind]
  const Icon = meta.icon
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2 p-6 text-center">
      <Icon className="h-8 w-8 text-muted-foreground" />
      <p className="text-sm font-medium text-foreground">{meta.title}</p>
      <p className="text-xs text-muted-foreground">Not wired up yet.</p>
    </div>
  )
}

/** Panel cards shown when the dock has no open tabs. */
function DockEmptyState({ onOpen }: { onOpen: (kind: DockKind) => void }) {
  return (
    <div className="flex-1 grid grid-cols-2 gap-3 p-6 content-center">
      {DOCK_KINDS.map((kind) => {
        const meta = TAB_META[kind]
        const Icon = meta.icon
        return (
          <button
            key={kind}
            type="button"
            onClick={() => onOpen(kind)}
            className="aspect-square flex flex-col items-center justify-center gap-2 rounded-xl border border-border text-sm text-foreground transition-colors hover:bg-accent hover:border-primary/40"
          >
            <Icon className="h-6 w-6" />
            <span>{meta.title}</span>
          </button>
        )
      })}
    </div>
  )
}
