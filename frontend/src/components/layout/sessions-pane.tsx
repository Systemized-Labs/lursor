import { useEffect, useMemo } from "react"
import {
  Bell,
  MagnifyingGlass,
  NotePencil,
  SlidersHorizontal,
  X,
} from "@phosphor-icons/react"
import type { Icon } from "@phosphor-icons/react"

import type { Workspace } from "@/api/types"
import { Button } from "@/components/ui/button"
import { useSidebar } from "@/components/ui/sidebar"
import { ActivityPanel } from "@/components/layout/panel/activity-panel"
import { ConversationRow } from "@/components/layout/panel/conversation-row"
import type { ConversationHandlers } from "@/components/layout/panel/types"
import {
  ProjectsSection,
  SectionHeading,
} from "@/components/layout/sessions/projects-section"
import { SessionsFooter } from "@/components/layout/sessions/sessions-footer"
import type { SessionsViewState } from "@/components/layout/use-sessions-view"
import type { WorkspaceIcons } from "@/components/layout/use-workspace-icons"
import type { WorkspaceStatus } from "@/components/layout/use-workspace-status"
import type { WorkspaceTree } from "@/components/layout/use-workspace-tree"
import type { WorkspaceDialogs } from "@/components/layout/workspace-dialogs"
import type { AllThreads } from "@/hooks/use-all-threads"
import type { Pins } from "@/components/layout/use-pins"
import { isElectron } from "@/lib/platform"
import { cn } from "@/lib/utils"

interface SessionsPaneProps {
  view: SessionsViewState
  threads: AllThreads
  tree: WorkspaceTree
  studio: Workspace | undefined
  icons: WorkspaceIcons
  status: WorkspaceStatus
  pins: Pins
  activeWorkspaceId: string | undefined
  unreadCount: number
  hrefFor: (workspaceId: string) => string
  onOpenWorkspace: (workspaceId: string) => void
  onNewConversation: (workspaceId: string) => void
  onNewChat: () => void
  onSearch: () => void
  onOpenCapabilities: () => void
  dialogs: WorkspaceDialogs
  handlers: ConversationHandlers
}

/**
 * The sidebar: one column, no icon rail.
 *
 * Replaces `nav-rail` (68px of workspace tiles) plus `sidebar-panel` (a
 * contextual list beside it). Two columns existed because the rail had to survive
 * collapsing so workspaces were always reachable — but it cost every destination
 * a place in the footer's `⋯` menu, left workspace names truncated to 10px, and
 * meant the sidebar had two widths and two toggles. One column says the names
 * outright, holds the nav rows the reference UI puts at the top, and leaves ⌘B as
 * the only sidebar shortcut.
 *
 * What is *not* here, deliberately: an Artifacts row. The plan's §5 lists one, but
 * the pane it opens does not exist until Phase 6, and a nav row that opens nothing
 * is worse than a gap where one will go — the same call made for the WindowBar's
 * Layouts button.
 */
export function SessionsPane({
  view,
  threads,
  tree,
  studio,
  icons,
  status,
  pins,
  activeWorkspaceId,
  unreadCount,
  hrefFor,
  onOpenWorkspace,
  onNewConversation,
  onNewChat,
  onSearch,
  onOpenCapabilities,
  dialogs,
  handlers,
}: SessionsPaneProps) {
  const { isMobile, setOpenMobile } = useSidebar()

  // ⌘N → a new session. Electron only, for the same reason `use-workspace-switch`
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
          label="New session"
          shortcut={isElectron ? "⌘N" : undefined}
          onClick={onNewChat}
        />
        <NavRow
          icon={SlidersHorizontal}
          label="Capabilities"
          onClick={onOpenCapabilities}
        />
        <NavRow
          icon={Bell}
          label="Activity"
          badge={unreadCount}
          active={view.view === "activity"}
          onClick={() =>
            view.setView(view.view === "activity" ? "projects" : "activity")
          }
        />
        <NavRow
          icon={MagnifyingGlass}
          label="Search sessions…"
          shortcut="⌘K"
          onClick={onSearch}
        />
      </div>

      <div
        aria-hidden
        className="mx-3 my-2 h-px shrink-0 bg-sidebar-border"
      />

      {/* ── The list ─────────────────────────────────────────────────────── */}
      <div className="scrollbar-hover min-h-0 flex-1 overflow-y-auto pb-2">
        {view.view === "activity" ? (
          <ActivityPanel
            allThreads={threads.threads}
            workspaceName={threads.workspaceName}
            isLoading={threads.isLoading}
            {...handlers}
          />
        ) : (
          <>
            {/* Pinned only exists once something is pinned. An always-present
                empty section would spend two rows telling you about a feature
                instead of showing you your projects. The hint goes in the
                conversation context menu, where the action is. */}
            {pinnedThreads.length > 0 ? (
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
                        handlers.selection.selectThread(
                          thread,
                          mods,
                          pinnedThreads
                        )
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
              drilledId={view.drilledId}
              onDrillInto={view.drillInto}
              onDrillOut={view.drillOut}
            />
          </>
        )}
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

/** One of the pane's top rows: an icon, a label, and either a chord or a count. */
function NavRow({
  icon: RowIcon,
  label,
  shortcut,
  badge,
  active,
  onClick,
}: {
  icon: Icon
  label: string
  shortcut?: string
  badge?: number
  active?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "group/nav flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sidebar-foreground outline-none ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2",
        active && "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
      )}
    >
      <RowIcon className="size-4 shrink-0 text-sidebar-foreground/70" />
      <span className="min-w-0 flex-1 truncate text-[13px] leading-5">
        {label}
      </span>
      {badge && badge > 0 ? (
        <span
          aria-label={`${badge} unread`}
          className="min-w-4 shrink-0 rounded-full bg-sidebar-primary px-1 text-[10px] font-medium leading-4 tabular-nums text-sidebar-primary-foreground"
        >
          {badge > 9 ? "9+" : badge}
        </span>
      ) : shortcut ? (
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
