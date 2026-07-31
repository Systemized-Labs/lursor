import {
  ArrowsIn,
  ArrowsOutSimple,
  GitDiff,
  FileCode,
  Globe,
  Plus,
  Terminal,
  SidebarSimple,
  X,
} from "@phosphor-icons/react"
import type { ElementType } from "react"

import { Suspense, lazy, useCallback, useEffect, useState } from "react"

import { ChangesPanel } from "@/components/shell/changes-panel"
import { PreviewPanel } from "@/components/shell/preview-panel"
import { TerminalPanel } from "@/components/shell/terminal-panel"
import { DOCK_KINDS, type DockKind, type DockTab } from "@/hooks/use-dock-state"
import { useMacTitlebar } from "@/hooks/use-mac-titlebar"

// Monaco is heavy (~5MB); load the file editor only when a Files panel opens so
// it never weighs down the base app.
const FileViewer = lazy(() =>
  import("@/components/files/file-viewer").then((m) => ({
    default: m.FileViewer,
  }))
)

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

const TAB_META: Record<DockKind, { title: string; icon: ElementType }> = {
  changes: { title: "Changes", icon: GitDiff },
  file: { title: "Files", icon: FileCode },
  preview: { title: "Preview", icon: Globe },
  terminal: { title: "Terminal", icon: Terminal },
}

interface RightDockProps {
  /** The active workspace id, used to root dock content (e.g. the terminal). */
  workspaceId?: string
  /** Open tabs, their active selection, and mutations — owned by the shell so
   *  they can be persisted per workspace. */
  tabs: DockTab[]
  activeId: string | null
  onOpenTab: (kind: DockKind) => void
  onCloseTab: (id: string) => void
  onSelectTab: (id: string) => void
  /** Collapse the dock (shell hides it and offers a re-open affordance). */
  onCollapse: () => void
  /** Whether the dock currently fills the window. */
  maximized: boolean
  onSetMaximized: (maximized: boolean) => void
}

/**
 * `Esc` restores a maximized dock — but only when it is the outermost thing Esc
 * could mean.
 *
 * Radix dialogs, dropdowns and context menus stop propagation on their own Esc
 * handling, so those never reach us. Monaco's find widget does not: it closes on
 * Esc from a keydown handler on its own input, and the event still bubbles to
 * `window`. Closing find should not also unmaximize the panel, so an Esc raised
 * from inside the editor is left alone — the editor is exactly where Esc has a
 * local meaning, and clicking outside it (or pressing the ⤡ button) is the way
 * out from there.
 */
function useEscapeToRestore(active: boolean, onRestore: () => void) {
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      if (target?.closest(".monaco-editor, [role='dialog'], [role='menu']")) return
      onRestore()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [active, onRestore])
}

/**
 * The right-side, editor-style panel dock — the Cursor "agent view" right pane.
 *
 * Hosts closeable tabs with a `+` menu and an empty state of panel cards.
 * Changes, files, preview, and terminal host real content. Tab/collapse state is
 * owned by the shell so it can be persisted per workspace.
 *
 * A kind can be open more than once (two previews on different ports, two
 * terminals, …). Duplicates are told apart in the strip by the detail their
 * panel reports — a preview's port, an editor's file — falling back to an
 * ordinal while a fresh panel has nothing to report yet.
 *
 * The strip also carries the size controls: maximize, which asks the shell to give
 * the dock the whole window, and collapse, which hides it behind the rail. Both are
 * dock-level — the panel inside is never remounted for either, so terminal sessions
 * and editor state survive.
 */
export function RightDock({
  workspaceId,
  tabs,
  activeId,
  onOpenTab,
  onCloseTab,
  onSelectTab,
  onCollapse,
  maximized,
  onSetMaximized,
}: RightDockProps) {
  const restore = useCallback(() => onSetMaximized(false), [onSetMaximized])
  useEscapeToRestore(maximized, restore)
  // What each panel wants shown beside its title, by tab id. Panel-reported and
  // transient — it's derived from live panel state, so there's nothing to
  // persist; a restored tab reports again as soon as it mounts.
  const [details, setDetails] = useState<Record<string, string | null>>({})
  const reportDetail = useCallback((tabId: string, detail: string | null) => {
    setDetails((prev) =>
      (prev[tabId] ?? null) === detail ? prev : { ...prev, [tabId]: detail }
    )
  }, [])
  const closeTab = useCallback(
    (id: string) => {
      setDetails(({ [id]: _gone, ...rest }) => rest)
      onCloseTab(id)
    },
    [onCloseTab]
  )

  // Detail is only shown for a kind that's open more than once — it exists to
  // tell duplicates apart, and the strip is narrow enough that a lone "Preview"
  // shouldn't spend width restating what it's pointed at. The ordinal covers a
  // duplicate whose panel has nothing to report yet (a blank preview).
  const macTitlebar = useMacTitlebar()

  const kindTotals = tabs.reduce<Record<string, number>>((acc, t) => {
    acc[t.kind] = (acc[t.kind] ?? 0) + 1
    return acc
  }, {})
  const seenOfKind: Record<string, number> = {}

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-background">
      {/* Tab strip. It sits at the top of the window beside the chat header, so
          on macOS it takes that header's chrome line — height and tone both. At
          36px and `bg-background` it met the header's bottom edge 8px short of
          it, in a different colour, breaking a band that otherwise runs the full
          width of the window. */}
      <div
        className={cn(
          "flex shrink-0 items-center gap-1 border-b border-border/40 px-1.5",
          macTitlebar.enabled ? "h-11 bg-sidebar" : "h-9",
          // Maximized, this strip is the only thing under the macOS traffic
          // lights: the dock starts at the sidebar's 68px gutter and the buttons
          // end around x=84, so the first tab lands beneath the green one. Inset
          // past them — the same 26px the chat header uses from the same offset.
          // Only while maximized; unmaximized the dock is over on the right and
          // the padding would just be a gap.
          macTitlebar.clearButtons && maximized && "pl-[26px]"
        )}
      >
        <div className="flex-1 flex items-center gap-0.5 overflow-x-auto">
          {tabs.map((t) => {
            const { title, icon: Icon } = TAB_META[t.kind]
            const isActive = t.id === activeId
            const ordinal = (seenOfKind[t.kind] = (seenOfKind[t.kind] ?? 0) + 1)
            const detail =
              kindTotals[t.kind] > 1 ? details[t.id] || String(ordinal) : null
            return (
              <div
                key={t.id}
                role="tab"
                aria-selected={isActive}
                tabIndex={0}
                title={detail ? `${title} — ${detail}` : title}
                onClick={() => onSelectTab(t.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") onSelectTab(t.id)
                }}
                className={cn(
                  "group flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs whitespace-nowrap cursor-pointer",
                  isActive
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span>{title}</span>
                {detail && (
                  <span
                    className={cn(
                      "max-w-[8rem] truncate",
                      isActive ? "text-muted-foreground" : "opacity-70"
                    )}
                  >
                    {detail}
                  </span>
                )}
                <span
                  role="button"
                  aria-label={`Close ${detail ? `${title} ${detail}` : title}`}
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
            <DropdownMenuContent align="start">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Panels</DropdownMenuLabel>
                {DOCK_KINDS.map((kind) => {
                  const Icon = TAB_META[kind].icon
                  return (
                    <DropdownMenuItem key={kind} onClick={() => onOpenTab(kind)}>
                      <Icon className="h-4 w-4" />
                      <span>{TAB_META[kind].title}</span>
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Maximize sits before collapse: the pair reads as one size control,
            and the two extremes of it belong next to each other. */}
        <button
          type="button"
          onClick={() => onSetMaximized(!maximized)}
          aria-pressed={maximized}
          title={maximized ? "Restore panel size (Esc)" : "Maximize panel"}
          aria-label={maximized ? "Restore panel size" : "Maximize panel"}
          className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-accent shrink-0"
        >
          {maximized ? (
            <ArrowsIn className="h-4 w-4" />
          ) : (
            <ArrowsOutSimple className="h-4 w-4" />
          )}
        </button>

        <button
          type="button"
          onClick={onCollapse}
          title="Hide panel"
          aria-label="Hide panel"
          className="rounded-md p-1 text-muted-foreground hover:text-foreground hover:bg-accent shrink-0"
        >
          <SidebarSimple className="h-4 w-4" />
        </button>
      </div>

      {/* Body: all open panels mounted, inactive ones hidden */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {tabs.length === 0 ? (
          <DockEmptyState onOpen={onOpenTab} />
        ) : (
          tabs.map((t) => (
            <div
              key={t.id}
              className={cn(
                "flex-1 min-h-0 flex flex-col",
                t.id !== activeId && "hidden"
              )}
            >
              <DockPanelContent
                kind={t.kind}
                workspaceId={workspaceId}
                tabId={t.id}
                active={t.id === activeId}
                onDetail={reportDetail}
              />
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export interface DockPanelProps {
  kind: DockKind
  workspaceId?: string
  /**
   * Id of the hosting tab. Stable across reloads and unique app-wide, so a panel
   * can key its own persisted state off it (see `@/lib/tab-storage`) instead of
   * sharing one workspace-wide slot with its duplicates.
   */
  tabId: string
  /**
   * Whether this is the tab currently on screen. Panels that consume the app's
   * global "open this file / URL here" requests only act when active, so a
   * request lands in the panel the user is looking at rather than in whichever
   * duplicate mounted first.
   */
  active: boolean
  /** Report a short label for the tab strip (a port, a filename). */
  onDetail?: (tabId: string, detail: string | null) => void
}

/** Panel body: real content where wired up, a placeholder otherwise. Exported
 *  so the mobile shell can render a single panel full-screen (the phone layout
 *  swaps the whole view via the bottom bar rather than a side-by-side dock). */
export function DockPanelContent({
  kind,
  workspaceId,
  tabId,
  active,
  onDetail,
}: DockPanelProps) {
  if (kind === "changes") {
    return <ChangesPanel workspaceId={workspaceId} />
  }
  if (kind === "terminal") {
    return <TerminalPanel workspaceId={workspaceId} />
  }
  if (kind === "preview") {
    return (
      <PreviewPanel
        workspaceId={workspaceId}
        tabId={tabId}
        active={active}
        onDetail={onDetail}
      />
    )
  }
  if (kind === "file") {
    return (
      <Suspense
        fallback={
          <div className="flex-1 flex items-center justify-center p-6 text-sm text-muted-foreground">
            Loading editor…
          </div>
        }
      >
        <FileViewer
          workspaceId={workspaceId}
          tabId={tabId}
          active={active}
          onDetail={onDetail}
        />
      </Suspense>
    )
  }

  // Every DockKind above returns its own panel, so `kind` is `never` here.
  // Kept as an exhaustiveness guard: a newly added kind will surface as a type
  // error until it gets a branch above.
  return null
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
            className="aspect-square flex flex-col items-center justify-center gap-2 rounded-xl bg-muted/40 text-sm text-foreground shadow-sm transition-all hover:bg-muted hover:shadow-md"
          >
            <Icon className="h-6 w-6" />
            <span>{meta.title}</span>
          </button>
        )
      })}
    </div>
  )
}
