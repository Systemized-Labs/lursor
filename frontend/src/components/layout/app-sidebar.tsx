import { useEffect, useMemo, useRef } from "react"
import { matchPath, useLocation, useNavigate, useSearchParams } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"

import { invalidateThreadLists, threadKeys, useActiveRuns } from "@/api/threads"
import { Sidebar, SidebarRail, useSidebar } from "@/components/ui/sidebar"
import { useCommandPalette } from "@/components/command-palette/command-palette"
import { NavRail } from "@/components/layout/nav-rail"
import { routeHasPanel } from "@/components/layout/rail-items"
import { SidebarPanel } from "@/components/layout/sidebar-panel"
import { usePanelMode, type PanelMode } from "@/components/layout/use-panel-mode"
import { useOpenWorkspaces } from "@/components/layout/use-open-workspaces"
import { useSidebarSelection } from "@/components/layout/use-sidebar-selection"
import { useWorkspaceDialogs } from "@/components/layout/workspace-dialogs"
import { useAllThreads } from "@/hooks/use-all-threads"
import { useOptimisticRuns } from "@/hooks/use-optimistic-runs"
import { markThreadRead, seedThreadReads } from "@/hooks/use-thread-reads"
import { useThreadState } from "@/hooks/use-thread-state"

/**
 * The left navigation: a fixed 68px destination rail and a contextual panel
 * beside it.
 *
 * The split is the whole idea. One column previously carried five jobs — nav,
 * workspaces, conversations, dialogs and bulk selection — which forced a fixed
 * carve-up of its height and pushed the conversations, the thing you touch every
 * minute, below seven rows of chrome. Destinations are low-frequency and read
 * fine at 68px; conversations need the width. So they get a column each.
 *
 * This component now only wires them together: shared state (panel mode, open
 * sections, selection, the run set) lives here, everything else is delegated.
 */
export function AppSidebar() {
  const { pathname } = useLocation()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { isMobile, setOpenMobile, open, setOpen } = useSidebar()
  const { open: openCommandPalette } = useCommandPalette()
  const qc = useQueryClient()

  const activeRunsQuery = useActiveRuns()
  // Union the polled server runs with locally-optimistic ones so a just-sent
  // message shows "working" instantly, before the 3s poll catches up.
  const optimisticRuns = useOptimisticRuns()
  const activeRuns = useMemo(
    () => new Set([...(activeRunsQuery.data ?? []), ...optimisticRuns]),
    [activeRunsQuery.data, optimisticRuns]
  )

  const chatMatch =
    matchPath("/workspaces/:workspaceId/chat", pathname) ??
    matchPath("/workspaces/:workspaceId", pathname)
  const activeWorkspaceId = chatMatch?.params.workspaceId
  const activeThreadId = searchParams.get("c")

  const threads = useAllThreads()
  const threadState = useThreadState(activeThreadId, activeRuns)

  const [panelMode, setPanelMode] = usePanelMode()
  const openWorkspaces = useOpenWorkspaces(threads.workspaceIds, activeWorkspaceId)
  const selection = useSidebarSelection()

  // Arriving at a whole-page destination collapses the panel; leaving for a
  // chat or workspace brings it back in whatever mode you left it. Only on the
  // way *in*, the same guard the open-workspace set uses — so ⌘B (or the rail
  // drag handle) still wins while you stay put, and clicking Chats on the Usage
  // page pulls the panel back out rather than doing nothing.
  const hasPanel = routeHasPanel(pathname)
  const prevHasPanel = useRef<boolean | null>(null)
  useEffect(() => {
    const prev = prevHasPanel.current
    prevHasPanel.current = hasPanel
    if (prev === hasPanel) return
    // On a cold load, only collapse — forcing it open here would throw away the
    // collapsed state the sidebar cookie just restored.
    if (prev === null) {
      if (!hasPanel) setOpen(false)
      return
    }
    setOpen(hasPanel)
  }, [hasPanel, setOpen])

  // The panel is a sheet on mobile, where it is the whole navigation and always
  // shows. On desktop it is whatever the collapse state says.
  const panelVisible = isMobile || open

  const showPanel = (mode: PanelMode) => {
    setPanelMode(mode)
    setOpen(true)
  }

  // When a background run finishes (its id leaves the active set), refresh the
  // conversation lists so they reorder by recency and pick up the new
  // updated_at that drives the "finished, unopened" badge.
  const prevRuns = useRef(activeRuns)
  useEffect(() => {
    const prev = prevRuns.current
    prevRuns.current = activeRuns
    let finished = false
    for (const id of prev) {
      if (!activeRuns.has(id)) {
        finished = true
        break
      }
    }
    if (finished) {
      invalidateThreadLists(qc)
      // Reconcile the poll now rather than up to 3s later, so a still-running
      // goal loop re-appears promptly after its optimistic flag clears.
      qc.invalidateQueries({ queryKey: threadKeys.activeRuns() })
    }
  }, [activeRuns, qc])

  // Reconcile read state from the one list that sees every conversation:
  // record threads on first sight (so pre-existing activity isn't retroactively
  // flagged) and keep the open conversation marked read as its activity
  // advances. Collapsed sections no longer fetch, so this can't live in them.
  useEffect(() => {
    seedThreadReads(threads.threads)
    const openThread = threads.threads.find((t) => t.id === activeThreadId)
    if (openThread) markThreadRead(openThread.id, openThread.updated_at)
  }, [threads.threads, activeThreadId])

  // "You have N things waiting", visible without expanding anything — the first
  // time that count has had anywhere to live.
  const unreadCount = useMemo(
    () => threads.threads.filter((t) => threadState(t).unread).length,
    [threads.threads, threadState]
  )

  const closeMobile = () => {
    if (isMobile) setOpenMobile(false)
  }

  const newConversation = (workspaceId: string) => {
    openWorkspaces.open(workspaceId)
    navigate(`/workspaces/${workspaceId}/chat`)
    closeMobile()
  }

  const dialogs = useWorkspaceDialogs({
    selection,
    activeWorkspaceId,
    activeThreadId,
  })

  const handlers = {
    activeThreadId,
    activeRuns,
    threadState,
    selection,
    onNavigate: closeMobile,
    onRename: dialogs.openRenameThread,
    onDelete: dialogs.openDeleteThread,
  }

  return (
    <Sidebar collapsible="icon">
      <div className="flex min-h-0 w-full flex-1">
        <NavRail
          panelMode={panelMode}
          onPanelMode={showPanel}
          panelVisible={panelVisible}
          studioId={threads.studioId}
          unreadCount={unreadCount}
          onNavigate={closeMobile}
        />
        {/* Not merely hidden: a CSS-hidden panel still mounts every workspace
            section, so the routes that collapse it would keep building a list
            nobody can see. */}
        {panelVisible ? (
          <SidebarPanel
            panelMode={panelMode}
            threads={threads}
            openWorkspaces={openWorkspaces}
            activeWorkspaceId={activeWorkspaceId}
            handlers={handlers}
            dialogs={dialogs}
            onNewConversation={newConversation}
            onNewChat={() => {
              navigate("/")
              closeMobile()
            }}
            onSearch={() => {
              openCommandPalette()
              closeMobile()
            }}
          />
        ) : null}
      </div>

      <SidebarRail />

      {dialogs.dialogs}
    </Sidebar>
  )
}
