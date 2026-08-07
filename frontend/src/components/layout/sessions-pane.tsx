import { useCallback, useEffect, useMemo } from "react"
import {
  Lightning,
  MagnifyingGlass,
  NotePencil,
  SlidersHorizontal,
  Stack,
  X,
} from "@phosphor-icons/react"
import type { Icon } from "@phosphor-icons/react"

import type { Workspace } from "@/api/types"
import { useAssistantOverlay } from "@/components/assistant/use-assistant-overlay"
import { Button } from "@/components/ui/button"
import { useSidebar } from "@/components/ui/sidebar"
import { ConversationRow } from "@/components/layout/sessions/conversation-row"
import type { ConversationHandlers } from "@/components/layout/sessions/types"
import {
  ProjectsSection,
  SectionHeading,
} from "@/components/layout/sessions/projects-section"
import { SessionsFooter } from "@/components/layout/sessions/sessions-footer"
import type { ProjectDrill } from "@/components/layout/use-project-drill"
import type { WorkspaceIcons } from "@/components/layout/use-workspace-icons"
import type { WorkspaceStatus } from "@/components/layout/use-workspace-status"
import type { WorkspaceTree } from "@/components/layout/use-workspace-tree"
import type { WorkspaceDialogs } from "@/components/layout/workspace-dialogs"
import type { AllThreads } from "@/hooks/use-all-threads"
import type { Pins } from "@/components/layout/use-pins"
import { isElectron } from "@/lib/platform"

interface SessionsPaneProps {
  drill: ProjectDrill
  threads: AllThreads
  tree: WorkspaceTree
  studio: Workspace | undefined
  icons: WorkspaceIcons
  status: WorkspaceStatus
  pins: Pins
  activeWorkspaceId: string | undefined
  hrefFor: (workspaceId: string) => string
  onOpenWorkspace: (workspaceId: string) => void
  onNewConversation: (workspaceId: string) => void
  onNewChat: () => void
  onSearch: () => void
  onOpenCapabilities: () => void
  onOpenArtifacts: () => void
  dialogs: WorkspaceDialogs
  handlers: ConversationHandlers
}

/**
 * The sidebar: one column, one list.
 *
 * Replaces `nav-rail` (68px of workspace tiles) plus `sidebar-panel` (a
 * contextual list beside it). Two columns existed because the rail had to survive
 * collapsing so workspaces were always reachable — but it cost every destination
 * a place in the footer's `⋯` menu, left workspace names truncated to 10px, and
 * meant the sidebar had two widths and two toggles. One column says the names
 * outright, holds the nav rows the reference UI puts at the top, and leaves ⌘B as
 * the only sidebar shortcut.
 *
 * The list is the projects, and nothing else: the Activity feed that used to be
 * the alternative *view* is gone. It was a second cross-workspace list of the
 * same conversations, with its own filters and its own time buckets, reachable
 * only by leaving the projects behind — and everything it told you the list can
 * say in place. Projects now carry their recent sessions inline, so scanning
 * across them is the default state rather than a mode, and the running dot and
 * unread count ride on each project row.
 */
export function SessionsPane({
  drill,
  threads,
  tree,
  studio,
  icons,
  status,
  pins,
  activeWorkspaceId,
  hrefFor,
  onOpenWorkspace,
  onNewConversation,
  onNewChat,
  onSearch,
  onOpenCapabilities,
  onOpenArtifacts,
  dialogs,
  handlers,
}: SessionsPaneProps) {
  const { isMobile, setOpenMobile } = useSidebar()
  const { setOpen: setAssistantOpen } = useAssistantOverlay()
  const openAssistant = useCallback(() => setAssistantOpen(true), [setAssistantOpen])

  // ⌘N → a new chat. Electron only, for the same reason `use-workspace-switch`
  // refuses ⌘1–⌘9 in a browser: ⌘N is the browser's "new window" and is not ours
  // to take. The chord is only *shown* where it is bound, so the label never
  // advertises a shortcut that does nothing.
  useEffect(() => {
    if (!isElectron) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "n") return
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) {
        return
      }
      event.preventDefault()
      onNewChat()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onNewChat])

  const threadsFor = (workspaceId: string) =>
    threads.byWorkspace.get(workspaceId) ?? []

  // Pinned conversations, in the cross-workspace list's own order (newest
  // first) rather than pin order: a pin says "keep this reachable", not "keep
  // this third".
  const pinnedThreads = useMemo(
    () => threads.threads.filter((thread) => pins.has(thread.id)),
    [threads.threads, pins]
  )

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col bg-sidebar">
      {/* ── Nav rows ─────────────────────────────────────────────────────── */}
      <div className="flex shrink-0 flex-col gap-px px-2 pt-2">
        {/* The mobile drawer hides its own close, so give it a dismiss. */}
        {isMobile ? (
          <div className="flex items-center justify-end pb-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setOpenMobile(false)}
              aria-label="Close menu"
              className="size-7 text-sidebar-foreground/70 hover:bg-sidebar-accent"
            >
              <X className="size-4" />
            </Button>
          </div>
        ) : null}

        <NavRow
          icon={NotePencil}
          label="New chat"
          shortcut={isElectron ? "⌘N" : undefined}
          onClick={onNewChat}
        />
        <NavRow
          icon={SlidersHorizontal}
          label="Capabilities"
          onClick={onOpenCapabilities}
        />
        <NavRow
          icon={Stack}
          label="Artifacts"
          onClick={onOpenArtifacts}
        />
        <NavRow
          icon={MagnifyingGlass}
          label="Search"
          shortcut="⌘K"
          onClick={onSearch}
        />
        {/* Reads its own open state rather than taking a callback: the overlay
            is global, so nothing between here and the shell needs to carry it
            (see `use-assistant-overlay`). */}
        <NavRow
          icon={Lightning}
          label="Assistant"
          shortcut="⌘⇧A"
          onClick={openAssistant}
        />
      </div>

      <div
        aria-hidden
        className="mx-3 my-2 h-px shrink-0 bg-sidebar-border"
      />

      {/* ── The list ─────────────────────────────────────────────────────── */}
      <div className="scrollbar-hover min-h-0 flex-1 overflow-y-auto pb-2">
        {/* Pinned only exists once something is pinned, and only at the top
            level: drilled into one project, a cross-workspace section above its
            sessions would contradict the scope the heading just declared. An
            always-present empty section would also spend two rows telling you
            about a feature instead of showing you your projects — the hint goes
            in the conversation context menu, where the action is. */}
        {pinnedThreads.length > 0 && !drill.drilledId ? (
          <section className="min-w-0 px-2 pb-1">
            <SectionHeading label="Pinned" />
            <ul className="flex min-w-0 flex-col">
              {pinnedThreads.map((thread) => (
                <ConversationRow
                  key={thread.id}
                  thread={thread}
                  state={handlers.threadState(thread)}
                  variant="stacked"
                  workspaceName={threads.workspaceName(thread.workspace_id)}
                  isSelected={handlers.selection.isThreadSelected(thread.id)}
                  isPinned
                  onTogglePin={() => pins.toggle(thread.id)}
                  selection={handlers.selection}
                  onSelect={(mods) =>
                    handlers.selection.selectThread(thread, mods, pinnedThreads)
                  }
                  onNavigate={handlers.onNavigate}
                  onRename={handlers.onRename}
                  onDelete={handlers.onDelete}
                />
              ))}
            </ul>
          </section>
        ) : null}

        <ProjectsSection
          tree={tree}
          studio={studio}
          icons={icons}
          status={status}
          activeWorkspaceId={activeWorkspaceId}
          threadsFor={threadsFor}
          threadsLoading={threads.isLoading}
          hrefFor={hrefFor}
          onOpenWorkspace={onOpenWorkspace}
          onNewConversation={onNewConversation}
          dialogs={dialogs}
          handlers={handlers}
          drilledId={drill.drilledId}
          onDrillInto={drill.drillInto}
          onDrillOut={drill.drillOut}
        />
      </div>

      {/* ── Bulk selection ───────────────────────────────────────────────── */}
      {handlers.selection.count > 0 ? (
        <div className="mx-2 mb-1 flex shrink-0 items-center gap-1 rounded-md border border-sidebar-border bg-sidebar-accent/50 px-2 py-1">
          <span className="flex-1 truncate text-xs font-medium text-sidebar-foreground">
            {handlers.selection.count}{" "}
            {handlers.selection.count > 1 ? "conversations" : "conversation"}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={dialogs.openBulkDelete}
            className="h-6 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            Delete
          </Button>
          <button
            type="button"
            onClick={handlers.selection.clear}
            className="rounded-md px-2 py-0.5 text-xs font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            Done
          </button>
        </div>
      ) : null}

      <SessionsFooter
        onNavigate={() => {
          if (isMobile) setOpenMobile(false)
        }}
      />
    </div>
  )
}

/**
 * One of the pane's top rows: an icon, a label, and its chord on hover.
 *
 * Every row here now *does* something and comes straight back — a dialog, the
 * palette, a route. None of them is a state the pane sits in, so the row has no
 * active styling and no badge; those existed for Activity, which was the one row
 * that changed what the list below it showed.
 */
function NavRow({
  icon: RowIcon,
  label,
  shortcut,
  onClick,
}: {
  icon: Icon
  label: string
  shortcut?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group/nav flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sidebar-foreground outline-none ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2"
    >
      <RowIcon className="size-4 shrink-0 text-sidebar-foreground/70" />
      <span className="min-w-0 flex-1 truncate text-[13px] leading-5">
        {label}
      </span>
      {shortcut ? (
        // Only on hover: a column of chords down the pane competes with the
        // labels for the same glance, and you either know them or you don't.
        <span
          aria-hidden
          className="shrink-0 text-[10px] tabular-nums text-sidebar-foreground/35 opacity-0 group-hover/nav:opacity-100"
        >
          {shortcut}
        </span>
      ) : null}
    </button>
  )
}
