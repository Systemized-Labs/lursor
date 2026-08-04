import { useEffect, useMemo, useRef } from "react"
import { matchPath, useLocation, useNavigate, useSearchParams } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"

import { invalidateThreadLists, threadKeys, useActiveRuns } from "@/api/threads"
import { Sidebar, SidebarRail, useSidebar } from "@/components/ui/sidebar"
import { useCommandPalette } from "@/components/command-palette/command-palette"
import { NavRail } from "@/components/layout/nav-rail"
import { SidebarPanel } from "@/components/layout/sidebar-panel"
import { usePanelMode } from "@/components/layout/use-panel-mode"
import { useSidebarSelection } from "@/components/layout/use-sidebar-selection"
import { useWorkspaceIcons } from "@/components/layout/use-workspace-icons"
import { useWorkspaceStatus } from "@/components/layout/use-workspace-status"
import { useWorkspaceTree } from "@/components/layout/use-workspace-tree"
import { useWorkspaceSwitch } from "@/components/layout/use-workspace-switch"
import { useWorkspaceDialogs } from "@/components/layout/workspace-dialogs"
import { useAllThreads } from "@/hooks/use-all-threads"
import { useOptimisticRuns } from "@/hooks/use-optimistic-runs"
import { markThreadRead, seedThreadReads } from "@/hooks/use-thread-reads"
import { useThreadState } from "@/hooks/use-thread-state"
import { useWorkspaceVisits } from "@/hooks/use-workspace-visits"

/**
 * The left navigation: a workspace rail and a contextual panel beside it.
 *
 * The rail holds workspaces, which is the change everything else follows from.
 * It used to hold destinations — eight of them, including four pages you open
 * once a session — while workspaces lived as collapsible folders inside the
 * panel. That made returning to a workspace a four-step operation (reopen the
 * panel, find the folder, expand it, guess the conversation), and impossible
 * without the mouse. Switching between a couple of repos all day is the actual
 * workload, so it gets the always-visible column, ⌘1…⌘9, and a double-⌘ MRU
 * toggle; the pages that were there before collapse into one ⋯ menu.
 *
 * The rail has two widths — icons at 68px, icons and names at 232px (⇧⌘B) — and
 * its workspaces can be filed into folders, which are groups in the list and
 * nothing on disk. Both are in `use-workspace-tree` and `nav-rail`.
 *
 * This component wires them together: shared state (panel mode, visit memory,
 * the workspace tree, selection, the run set) lives here, everything else is
 * delegated.
 */
export function AppSidebar() {
  const { pathname } = useLocation()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { isMobile, setOpenMobile, open } = useSidebar()
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
  const status = useWorkspaceStatus(threads.threads, threadState)

  const [panelMode, setPanelMode] = usePanelMode()
  const selection = useSidebarSelection()
  const visits = useWorkspaceVisits(threads.workspaceIds)
  const tree = useWorkspaceTree(threads.workspaces)
  const icons = useWorkspaceIcons(threads.workspaceIds)

  // Remember where you are, so switching back here later resumes it. Recorded
  // from the route rather than on click: arriving by ⌘K, by a link in a reply or
  // by reload all count as being here, and only the URL sees all of them.
  //
  // Keyed on `record` (stable) rather than the whole visits object, which changes
  // identity on every write — depending on that would re-run this effect after
  // each one, relying on the recorder's own de-dupe to stop the cycle.
  const { record } = visits
  useEffect(() => {
    if (activeWorkspaceId) record(activeWorkspaceId, activeThreadId)
  }, [activeWorkspaceId, activeThreadId, record])

  // The panel is a sheet on mobile, where it is the whole navigation and always
  // shows. On desktop it is whatever the collapse state says.
  //
  // Note what is *not* here any more: the rule that collapsed the panel on
  // whole-page routes and restored it on the way out. It existed because a
  // conversation list beside a usage chart is clutter — but it also meant those
  // routes had no way back to a workspace, which is the problem this redesign
  // exists to fix. The rail now answers that from everywhere, and ⌘B is still
  // there when you want the room.
  const panelVisible = isMobile || open

  const closeMobile = () => {
    if (isMobile) setOpenMobile(false)
  }

  const { switchTo, hrefFor } = useWorkspaceSwitch({
    // Tree order — groups' members counted where they sit — then the studio, so
    // ⌘N matches the numbers on the tiles, including the studio's at the end.
    orderedIds: useMemo(
      () => [
        ...tree.ordered.map((ws) => ws.id),
        ...(threads.studio ? [threads.studio.id] : []),
      ],
      [tree.ordered, threads.studio]
    ),
    visits,
    byWorkspace: threads.byWorkspace,
    activeWorkspaceId,
    onNavigate: () => {
      // Going to a workspace is a request for that workspace's conversations, so
      // the panel follows the switch. It is also the only way back to Chats:
      // Activity is a rail toggle, and with nothing setting the mode the other
      // way, one click on it left the panel showing Activity for good — a
      // persisted mode, so across restarts too.
      //
      // Unlike Activity this does not expand a collapsed panel. Activity exists
      // *to* be the panel, so a click that left it collapsed did nothing; a tile
      // is navigation, and re-opening a panel you put away on every workspace
      // switch would be taking that decision back.
      setPanelMode("chats")
      closeMobile()
    },
  })

  // Which workspace the Chats list is showing: the one you're in, or — on a page
  // that isn't a workspace — the one you were in most recently, so the panel is
  // still a way back rather than an empty column.
  const scopedWorkspace = useMemo(() => {
    const byId = new Map(threads.allWorkspaces.map((ws) => [ws.id, ws]))
    if (activeWorkspaceId) {
      const active = byId.get(activeWorkspaceId)
      if (active) return active
    }
    for (const id of visits.mru) {
      const recent = byId.get(id)
      if (recent) return recent
    }
    return tree.ordered[0] ?? threads.studio
  }, [
    threads.allWorkspaces,
    threads.studio,
    activeWorkspaceId,
    visits.mru,
    tree.ordered,
  ])

  const scopedThreads = useMemo(
    () =>
      scopedWorkspace ? (threads.byWorkspace.get(scopedWorkspace.id) ?? []) : [],
    [threads.byWorkspace, scopedWorkspace]
  )

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
  // advances.
  useEffect(() => {
    seedThreadReads(threads.threads)
    const openThread = threads.threads.find((t) => t.id === activeThreadId)
    if (openThread) markThreadRead(openThread.id, openThread.updated_at)
  }, [threads.threads, activeThreadId])

  // "You have N things waiting", on the Activity bell. The per-tile marks say
  // where; this says how many, in total, without opening anything.
  const unreadCount = useMemo(
    () => threads.threads.filter((t) => threadState(t).unread).length,
    [threads.threads, threadState]
  )

  const newConversation = (workspaceId: string) => {
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
    /* No chrome handling here any more. The traffic lights used to land on this
       sidebar's top-left, which forced it to reserve a 44px strip, host the
       panel heading inside that strip, and suppress its own right border across
       it so the window's boundary was not drawn through the green button. The
       WindowBar sits above the whole shell now, so none of that reaches this
       component: the sidebar starts below the lights and is an ordinary column
       again. */
    <Sidebar collapsible="icon">
      <div className="flex min-h-0 w-full flex-1">
        <NavRail
          tree={tree}
          studio={threads.studio}
          activeWorkspaceId={activeWorkspaceId}
          status={status}
          icons={icons}
          hrefFor={hrefFor}
          onOpenWorkspace={switchTo}
          panelMode={panelMode}
          onPanelMode={setPanelMode}
          panelVisible={panelVisible}
          unreadCount={unreadCount}
          onNavigate={closeMobile}
          onNewWorkspace={dialogs.openNewWorkspace}
          onNewFolder={dialogs.openNewFolder}
          onRenameFolder={dialogs.openRenameFolder}
          onDeleteFolder={dialogs.openDeleteFolder}
          onNewConversation={newConversation}
          onRenameWorkspace={dialogs.openRenameWorkspace}
          onCloneWorkspace={dialogs.openCloneWorkspace}
          onDeleteWorkspace={dialogs.openDeleteWorkspace}
        />
        {/* Not merely hidden: a CSS-hidden panel still mounts its list, so a
            collapsed sidebar would keep building rows nobody can see. */}
        {panelVisible ? (
          <SidebarPanel
            panelMode={panelMode}
            threads={threads}
            scopedWorkspace={scopedWorkspace}
            scopedThreads={scopedThreads}
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
