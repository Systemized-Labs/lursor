import { useCallback, useEffect, useMemo, useRef } from "react"
import { matchPath, useLocation, useNavigate, useSearchParams } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"

import { invalidateThreadLists, threadKeys, useActiveRuns } from "@/api/threads"
import { Sidebar, SidebarRail, useSidebar } from "@/components/ui/sidebar"
import { useCommandPalette } from "@/components/command-palette/command-palette"
import { SessionsPane } from "@/components/layout/sessions-pane"
import { usePins } from "@/components/layout/use-pins"
import { useProjectDrill } from "@/components/layout/use-project-drill"
import { useSidebarSelection } from "@/components/layout/use-sidebar-selection"
import { useWorkspaceIcons } from "@/components/layout/use-workspace-icons"
import { useWorkspaceStatus } from "@/components/layout/use-workspace-status"
import { useWorkspaceTree } from "@/components/layout/use-workspace-tree"
import { useWorkspaceSwitch } from "@/components/layout/use-workspace-switch"
import { useWorkspaceDialogs } from "@/components/layout/workspace-dialogs"
import { useSettingsParam } from "@/components/settings/use-settings-param"
import { useAllThreads } from "@/hooks/use-all-threads"
import { useOptimisticRuns } from "@/hooks/use-optimistic-runs"
import { markThreadRead, seedThreadReads } from "@/hooks/use-thread-reads"
import { useThreadState } from "@/hooks/use-thread-state"
import { useWorkspaceVisits } from "@/hooks/use-workspace-visits"

/**
 * The left navigation: one column, {@link SessionsPane}.
 *
 * It used to be two — a 68px workspace rail plus a contextual panel — and before
 * that, destinations in the rail with workspaces as folders inside the panel. The
 * rail fixed the real problem (getting back to a workspace was a four-step
 * operation) but paid for it with a second column that had its own width, its own
 * toggle, and no room for anything but tiles: every whole-page destination ended
 * up behind one unlabelled `⋯`, and workspace names were 10px and truncated.
 *
 * One column of full-width rows carries the names, the nav rows and the sessions
 * together, and four of those buried destinations became settings categories in
 * Phase 2 rather than menu items here.
 *
 * It also used to have two *lists* — the projects, and an Activity feed of the
 * same conversations sorted by time — behind a nav row that swapped one for the
 * other. There is one list now: projects, each showing its recent sessions, and
 * drilling into one scopes the list to it. Navigating across conversations is
 * what the top level is for; working inside one project is what the drill is for.
 *
 * This component is the wiring: shared state (the drill scope, visit memory, the
 * workspace tree, selection, pins, the run set) lives here and everything else is
 * delegated.
 */
export function AppSidebar({ side = "left" }: { side?: "left" | "right" }) {
  const { pathname } = useLocation()
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  const { isMobile, setOpenMobile } = useSidebar()
  const { open: openCommandPalette } = useCommandPalette()
  const { openSettings } = useSettingsParam()
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

  const drill = useProjectDrill()
  const selection = useSidebarSelection()
  const pins = usePins()
  const visits = useWorkspaceVisits(threads.workspaceIds)
  const tree = useWorkspaceTree(threads.workspaces)
  const icons = useWorkspaceIcons(threads.workspaceIds)

  // Drop pins whose conversation is gone. Same guard as the icon overrides: wait
  // for a non-empty list, or the first render wipes the record.
  const { prune } = pins
  useEffect(() => {
    prune(threads.threads.map((thread) => thread.id))
  }, [threads.threads, prune])

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

  // `useCallback` because it is a member of `handlers` below, which is memoised for
  // the sake of every `ConversationRow` it is spread into. A fresh function here
  // would make that memo unable to hold.
  const closeMobile = useCallback(() => {
    if (isMobile) setOpenMobile(false)
  }, [isMobile, setOpenMobile])

  const { switchTo, hrefFor } = useWorkspaceSwitch({
    // Tree order — groups' members counted where they sit — then the studio, so
    // ⌘1…⌘9 match the digits shown on the rows, including the studio's at the end.
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
    onNavigate: closeMobile,
  })

  // ⌘1–⌘9 switch projects but do not drill: the shortcut's whole value is that it
  // is one keystroke, and re-scoping the list underneath would make the sidebar
  // jump on every hop between two repos.
  useEffect(() => {
    if (
      activeWorkspaceId &&
      drill.drilledId &&
      drill.drilledId !== activeWorkspaceId
    ) {
      drill.drillOut()
    }
    // Only when the active workspace changes — not when `drilledId` does, or
    // drilling into a project you are not in would immediately undo itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceId])

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

  const newConversation = (workspaceId: string) => {
    navigate(`/workspaces/${workspaceId}/chat`)
    closeMobile()
  }

  const dialogs = useWorkspaceDialogs({
    selection,
    activeWorkspaceId,
    activeThreadId,
  })

  /**
   * The per-row props, memoised.
   *
   * This object is spread into `WorkspaceConversations` and reaches every
   * `ConversationRow`, so rebuilding it made every row's props new on every sidebar
   * render — and the sidebar re-renders on each 3s active-runs poll.
   *
   * It holds because everything in it already does: `activeRuns`, `selection`,
   * `threadState` and the two `pins` callbacks are memoised in their own hooks, and
   * `openRenameThread`/`openDeleteThread` are `useState` setters. `dialogs` as a
   * whole is *not* stable and cannot be — it carries the dialog JSX, which has to
   * re-render — which is why these two members are depended on rather than the
   * object they come from.
   */
  const handlers = useMemo(
    () => ({
      activeThreadId,
      activeRuns,
      threadState,
      selection,
      isPinned: pins.has,
      onTogglePin: pins.toggle,
      onNavigate: closeMobile,
      onRename: dialogs.openRenameThread,
      onDelete: dialogs.openDeleteThread,
    }),
    [
      activeThreadId,
      activeRuns,
      threadState,
      selection,
      pins.has,
      pins.toggle,
      closeMobile,
      dialogs.openRenameThread,
      dialogs.openDeleteThread,
    ]
  )

  return (
    /* `offcanvas`, not `icon`. The collapsed state used to be the 68px rail —
       a better answer than a 3rem icon strip, and the reason the sidebar had two
       widths at all. With one column there is nothing to collapse *to*: ⌘B and the
       WindowBar's toggle either show the sidebar or they don't, and ⌘1–⌘9 keep
       projects reachable while it is away. */
    <Sidebar collapsible="offcanvas" side={side}>
      <SessionsPane
        drill={drill}
        threads={threads}
        tree={tree}
        studio={threads.studio}
        icons={icons}
        status={status}
        pins={pins}
        activeWorkspaceId={activeWorkspaceId}
        hrefFor={hrefFor}
        onOpenWorkspace={switchTo}
        onNewConversation={newConversation}
        onNewChat={() => {
          navigate("/")
          closeMobile()
        }}
        onSearch={() => {
          openCommandPalette()
          closeMobile()
        }}
        onOpenCapabilities={() => {
          openSettings("capabilities")
          closeMobile()
        }}
        onOpenArtifacts={() => {
          // Navigates to the *global* layout rather than adding a pane to the
          // workspace you are in. Artifacts, Usage, Video and Image span
          // workspaces — Usage by nature, Video and Image because they are scoped
          // to a LAIOS box — so the nav row goes to the surface. Wanting one
          // beside a chat is a different intent, and that is what a zone's `+` is
          // for.
          navigate("/artifacts")
          closeMobile()
        }}
        dialogs={dialogs}
        handlers={handlers}
      />

      <SidebarRail />

      {dialogs.dialogs}
    </Sidebar>
  )
}
