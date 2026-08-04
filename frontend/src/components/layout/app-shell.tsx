import { useCallback, useEffect, useRef, useState } from "react"
import type { CSSProperties, ReactNode } from "react"
import { Outlet, useLocation } from "react-router-dom"
import type { ImperativePanelHandle } from "react-resizable-panels"

import { useWorkspace } from "@/api/workspaces"
import { AppSidebar } from "@/components/layout/app-sidebar"
import { MobileHeader } from "@/components/layout/mobile-header"
import { destinationFor } from "@/components/layout/rail-items"
import { WINDOW_BAR_HEIGHT, WindowBar } from "@/components/layout/window-bar"
import { SettingsDialog } from "@/components/settings/settings-dialog"
import { useSettingsParam } from "@/components/settings/use-settings-param"
import { CommandPaletteProvider } from "@/components/command-palette/command-palette"
import { DockRail } from "@/components/shell/dock-rail"
import { MobileDockBar } from "@/components/shell/mobile-dock-bar"
import { MobilePlanView } from "@/components/shell/mobile-plan-view"
import { RightDock, DockPanelContent } from "@/components/shell/right-dock"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { SidebarInset, SidebarProvider, useSidebar } from "@/components/ui/sidebar"
import { hasStoredDockState, useDockState } from "@/hooks/use-dock-state"
import type { DockKind } from "@/hooks/use-dock-state"
import { useIsMobile } from "@/hooks/use-mobile"
import { usePreviewWatch } from "@/hooks/use-preview-watch"
import { cn } from "@/lib/utils"
import {
  consumePendingFile,
  peekPendingFile,
  subscribeOpenFile,
  type OpenFileRequest,
} from "@/lib/open-file"
import { isPlanFile } from "@/lib/plan-doc"
import {
  peekPendingPreview,
  subscribeOpenPreview,
  type OpenPreviewRequest,
} from "@/lib/open-preview"

/** Titles for the full-screen dock views shown via the mobile bottom bar. */
const MOBILE_DOCK_TITLES: Record<DockKind, string> = {
  changes: "Changes",
  file: "Files",
  terminal: "Terminal",
  preview: "Preview",
}

/**
 * The persistent app shell: a Cursor-style collapsible sidebar, the routed
 * center content, and a resizable right-side dock. A slim inset header carries
 * the sidebar toggle and (when the dock is hidden) a re-open affordance.
 *
 * On desktop the dock is a side-by-side split. On phones that split would crush
 * the content, so the shell adds a global top header (hamburger + title) and a
 * bottom tab bar (inside a workspace) that swaps the center view in place.
 */
export function AppShell() {
  const isMobile = useIsMobile()
  const { pathname } = useLocation()
  const { openSettings } = useSettingsParam()
  // The active workspace (from `/workspaces/:id/...`) keys the dock's persisted
  // layout, so each workspace remembers whether its dock is open and which
  // panels were up.
  const workspaceId = pathname.match(/\/workspaces\/([^/]+)/)?.[1]
  const dock = useDockState(workspaceId)
  // Keep the detected dev-server list live for the active workspace, so servers
  // the agent starts are known even before the Preview panel is opened.
  usePreviewWatch(workspaceId)
  // Workspace name feeds the mobile header title (cached — the chat page shares
  // this query).
  const workspaceForTitle = useWorkspace(workspaceId)
  // The dock is workspace-scoped (changes/files/terminal for a repo), so it
  // only makes sense inside a workspace route — not on the New Agent home,
  // Customization, or Settings surfaces.
  const dockVisible = !isMobile && !dock.collapsed && Boolean(workspaceId)

  // On mobile the bottom bar switches the center view in place (like tabs):
  // "chat" shows the routed content, a DockKind shows that panel full-screen.
  // Panels are mounted on first visit and kept alive (hidden) when switched
  // away, so a terminal session or editor buffer survives tab switches.
  const [mobileView, setMobileView] = useState<"chat" | "plan" | DockKind>(
    "chat"
  )
  const [visitedKinds, setVisitedKinds] = useState<DockKind[]>([])
  // The plan doc surfaced for this workspace's parked `/plan` turn, if any. The
  // Files editor is desktop-only, so on mobile a plan opens in a read-only
  // Markdown view instead (see the open-file effect below).
  const [mobilePlan, setMobilePlan] = useState<{ path: string } | null>(null)

  const showMobileKind = useCallback((kind: DockKind) => {
    setVisitedKinds((prev) => (prev.includes(kind) ? prev : [...prev, kind]))
    setMobileView(kind)
  }, [])

  // Leaving a workspace (or switching to desktop) snaps back to the chat view
  // and forgets which panels were mounted for the previous repo.
  useEffect(() => {
    if (!workspaceId || !isMobile) {
      setMobileView("chat")
      setVisitedKinds([])
      setMobilePlan(null)
    }
  }, [workspaceId, isMobile])

  // First visit to the Skill Studio: open the Files panel. Its whole point is
  // the tree over every skill, and a blank right-hand side hides that the dock
  // is even there. Only when nothing is stored for this workspace — after that
  // the layout is the user's, closed dock included.
  const seededDockRef = useRef<string | null>(null)
  useEffect(() => {
    const isStudio = workspaceForTitle.data?.is_system === true
    if (!isStudio || !workspaceId || isMobile) return
    if (seededDockRef.current === workspaceId) return
    seededDockRef.current = workspaceId
    if (hasStoredDockState(workspaceId)) return
    dock.ensureTab("file")
  }, [workspaceForTitle.data?.is_system, workspaceId, isMobile, dock])

  // Global "open this file" requests (from the command palette) land here: once
  // we're on the target workspace, reveal the dock and ensure a file tab so the
  // editor mounts and can pick the request up.
  const [openFileTick, setOpenFileTick] = useState(0)
  const handledPendingRef = useRef<OpenFileRequest | null>(null)
  useEffect(() => subscribeOpenFile(() => setOpenFileTick((t) => t + 1)), [])
  useEffect(() => {
    const pending = peekPendingFile()
    if (!pending || pending.workspaceId !== workspaceId) return
    // Guard by request identity so re-renders don't spawn duplicate file tabs.
    if (handledPendingRef.current === pending) return
    handledPendingRef.current = pending
    // The Monaco editor is desktop-only, so on mobile the FileViewer never
    // mounts to consume this request. Plan docs are the exception: route them to
    // the read-only mobile plan view (consuming the request ourselves so it
    // doesn't linger). Any other file has nowhere to go on a phone — leave it.
    if (isMobile) {
      if (isPlanFile(pending.name)) {
        consumePendingFile(workspaceId)
        setMobilePlan({ path: pending.path })
        setMobileView("plan")
      }
      return
    }
    dock.ensureTab("file")
    dock.setCollapsed(false)
  }, [openFileTick, workspaceId, dock, isMobile])

  // Global "open this URL in the preview" requests (from the right-click menu on
  // chat links): reveal the preview surface for the target workspace so the
  // PreviewPanel mounts and navigates. On mobile that's the full-screen preview
  // view; on desktop, the side dock's preview tab.
  const [openPreviewTick, setOpenPreviewTick] = useState(0)
  const handledPreviewRef = useRef<OpenPreviewRequest | null>(null)
  useEffect(() => subscribeOpenPreview(() => setOpenPreviewTick((t) => t + 1)), [])
  useEffect(() => {
    const pending = peekPendingPreview()
    if (!pending || pending.workspaceId !== workspaceId) return
    // Guard by request identity so re-renders don't re-open the dock repeatedly.
    if (handledPreviewRef.current === pending) return
    handledPreviewRef.current = pending
    if (isMobile) {
      showMobileKind("preview")
      return
    }
    dock.ensureTab("preview")
    dock.setCollapsed(false)
  }, [openPreviewTick, workspaceId, dock, isMobile, showMobileKind])

  // Full-bleed surfaces (e.g. a chat thread) manage their own scroll and fill
  // the panel edge to edge; everything else keeps the padded, centered column.
  const fullBleed =
    pathname === "/" ||
    pathname.includes("/threads/") ||
    pathname.endsWith("/chat")

  /**
   * The padded column every non-full-bleed route sits in.
   *
   * Customization gets a much wider cap than the rest. Its tabs are browsers and
   * grids that spend every pixel they are given — the two-pane Skills and
   * Environment rails most of all, where the default column left the detail pane
   * narrower than the rail beside it. Settings and Analytics are forms and prose,
   * which read worse the wider they get, so they keep the measured column.
   *
   * Still capped rather than edge-to-edge: on an ultrawide, an uncapped card grid
   * stretches three cards across two feet of desk. The cap is high enough that any
   * ordinary laptop is already below it and simply gets the full width.
   */
  const columnClass = "mx-auto w-full max-w-6xl"

  // ── Mobile layout ──────────────────────────────────────────────────────────
  // A single column under a global top header: the routed content fills the
  // space above a bottom tab bar (inside a workspace), and the bottom bar swaps
  // the center view in place.
  if (isMobile) {
    const mobileCenter = fullBleed ? (
      <main className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
        <Outlet />
      </main>
    ) : (
      <main className="flex-1 min-w-0 min-h-0 overflow-y-auto">
        <div
          className={cn(
            columnClass,
            "px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
          )}
        >
          <Outlet />
        </div>
      </main>
    )

    // Header title: the active dock view when one is up, otherwise the route.
    // Whole-page destinations name themselves from the rail's own list, so a new
    // one is titled correctly without a branch here.
    const routeTitle =
      destinationFor(pathname)?.label ??
      (workspaceId ? workspaceForTitle.data?.name ?? "Workspace" : "New chat")
    const mobileTitle =
      mobileView === "chat"
        ? routeTitle
        : mobileView === "plan"
          ? "Plan"
          : MOBILE_DOCK_TITLES[mobileView]

    return (
      <SidebarProvider>
        <CommandPaletteProvider>
          <AppSidebar />
          <SidebarInset className="min-w-0">
            <div className="flex h-svh min-h-0 flex-col overflow-hidden">
              <MobileHeader title={mobileTitle} />

              {/* Stacked full-screen views — only the active one is shown.
                  Layering (rather than conditional mount) keeps each panel's
                  state alive when the bottom bar switches away from it. */}
              <div className="relative min-h-0 flex-1">
                <div
                  className={cn(
                    "absolute inset-0 flex flex-col",
                    mobileView !== "chat" && "hidden"
                  )}
                >
                  {mobileCenter}
                </div>
                {workspaceId &&
                  visitedKinds.map((kind) => (
                    <div
                      key={kind}
                      className={cn(
                        "absolute inset-0 flex min-h-0 flex-col bg-background",
                        mobileView !== kind && "hidden"
                      )}
                    >
                      {/* One panel per kind here — the bottom bar has no notion
                          of duplicates — so a fixed id stands in for a tab id.
                          Scoped by workspace: these panels are not remounted on
                          a workspace switch, and per-tab storage is global, so a
                          shared id would carry the last repo's preview URL over. */}
                      <DockPanelContent
                        kind={kind}
                        workspaceId={workspaceId}
                        tabId={`mobile-${workspaceId}-${kind}`}
                        active={mobileView === kind}
                      />
                    </div>
                  ))}
                {workspaceId && (
                  <div
                    className={cn(
                      "absolute inset-0 flex min-h-0 flex-col bg-background",
                      mobileView !== "plan" && "hidden"
                    )}
                  >
                    <MobilePlanView
                      workspaceId={workspaceId}
                      path={mobilePlan?.path}
                    />
                  </div>
                )}
              </div>
              {workspaceId && (
                <MobileDockBar
                  activeKind={
                    mobileView === "chat" || mobileView === "plan"
                      ? null
                      : mobileView
                  }
                  planActive={mobileView === "plan"}
                  onSelectChat={() => setMobileView("chat")}
                  onSelectKind={showMobileKind}
                  onSelectPlan={() => setMobileView("plan")}
                />
              )}
            </div>
            {/* Reachable on a phone through the sidebar's Settings tile — there
                is no WindowBar here until the mobile pass. */}
            <SettingsDialog />
          </SidebarInset>
        </CommandPaletteProvider>
      </SidebarProvider>
    )
  }

  // ── Desktop layout ─────────────────────────────────────────────────────────
  // Full-bleed surfaces must fill exactly the space under the WindowBar so their
  // inner regions (e.g. a chat message list) scroll independently. The sidebar
  // shell is only `min-h-(--shell-height)` (a floor that grows with content), so
  // `flex-1`/`min-h-0` have no definite height to cap against — pin a concrete
  // one here instead. `--shell-height` is the viewport minus the WindowBar; it
  // falls back to the full viewport wherever no bar is reserved.
  const center = fullBleed ? (
    <main className="h-(--shell-height) min-w-0 flex flex-col overflow-hidden">
      <Outlet />
    </main>
  ) : (
    <main className="flex-1 min-w-0 overflow-y-auto">
      <div className={cn(columnClass, "px-4 py-6 sm:px-6")}>
        <Outlet />
      </div>
    </main>
  )

  return (
    /* A column, not the primitive's default row: the WindowBar is the frame's
       own strip and everything else lives under it. `--sidebar-top` is how the
       fixed sidebar box and every `--shell-height` consumer learn that the
       viewport now starts 44px down; nothing below has to know why. */
    <SidebarProvider
      className="h-svh flex-col overflow-hidden"
      style={{ "--sidebar-top": WINDOW_BAR_HEIGHT } as CSSProperties}
    >
      <CommandPaletteProvider>
        <WindowBar onOpenSettings={openSettings} />
        <div className="flex w-full min-h-0 flex-1">
          <AppSidebar />
          <ShellBody
            workspaceId={workspaceId}
            dock={dock}
            dockVisible={dockVisible}
            center={center}
          />
        </div>
        {/* Mounted at the shell, not per route: settings opens *over* whatever
            you were doing rather than replacing it. */}
        <SettingsDialog />
      </CommandPaletteProvider>
    </SidebarProvider>
  )
}

interface ShellBodyProps {
  workspaceId?: string
  dock: ReturnType<typeof useDockState>
  dockVisible: boolean
  center: ReactNode
}

/**
 * The desktop shell's inset: the routed content, its optional dock split, and
 * the rail.
 *
 * Split out of {@link AppShell} for one reason — it has to live *inside*
 * `SidebarProvider` to call {@link useSidebar}, which is what lets maximizing the
 * dock close the app sidebar as well as the chat column. Everything else here is
 * the markup that used to sit inline.
 *
 * Maximizing deliberately collapses the existing center panel rather than moving
 * the dock into an overlay: Monaco view state, terminal sessions and preview
 * iframes all die if a panel's position in the React tree changes, so the panel
 * group, the tree and every panel stay mounted throughout. Restoring returns to
 * the exact split the user had, because nothing was ever unmounted to lose it.
 */
function ShellBody({ workspaceId, dock, dockVisible, center }: ShellBodyProps) {
  const { open: sidebarOpen, setOpen: setSidebarOpen } = useSidebar()
  const centerPanelRef = useRef<ImperativePanelHandle>(null)
  const maximized = dockVisible && dock.maximized

  // Collapse/expand the center column to match `maximized`. Imperative because
  // the panel's size is owned by react-resizable-panels (and persisted under
  // `autoSaveId`), so driving it from a prop would fight the user's own drags.
  useEffect(() => {
    const panel = centerPanelRef.current
    if (!panel) return
    if (maximized) {
      if (!panel.isCollapsed()) panel.collapse()
    } else if (panel.isCollapsed()) {
      // Also the repair path for a saved layout that was collapsed when the
      // maximize flag didn't survive with it.
      panel.expand()
    }
  }, [maximized, dockVisible])

  // Close the app sidebar while maximized, and put it back on the way out. The
  // provider persists open state in a cookie, so the pre-maximize value is
  // snapshotted here rather than assumed to be "open".
  const sidebarWasOpen = useRef<boolean | null>(null)
  useEffect(() => {
    if (maximized) {
      if (sidebarWasOpen.current === null) {
        sidebarWasOpen.current = sidebarOpen
        setSidebarOpen(false)
      }
      return
    }
    if (sidebarWasOpen.current === null) return
    // Only undo our own close: a sidebar the user opened themselves while
    // maximized stays open.
    if (sidebarWasOpen.current && !sidebarOpen) setSidebarOpen(true)
    sidebarWasOpen.current = null
  }, [maximized, sidebarOpen, setSidebarOpen])

  return (
    /* `min-w-0` lets this flex child shrink below its content's intrinsic
       width; without it, widening the dock grows the whole inset past the
       viewport instead of redistributing space within it. */
    <SidebarInset className="min-w-0">
      {/* A horizontal row: the content area (with its optional dock split) and
          a thin, always-present rail whose toggle governs the dock. The rail
          owns a real column, so its toggle never overlaps page content.

          The row is pinned to a concrete `--shell-height` — the viewport minus
          the WindowBar (the sidebar shell is only a floor that grows with
          content). Without a definite height here, `flex-1`/`min-h-0`
          descendants have nothing to cap against, so a tall panel — e.g. a large
          Changes diff in the dock — would grow the whole inset and overflow the
          viewport instead of scrolling internally. `overflow-hidden` clips at
          the row so the split below always resolves its own scroll. */}
      <div className="flex h-(--shell-height) min-h-0 overflow-hidden">
        <div className="flex flex-1 flex-col min-w-0 min-h-0">
          {dockVisible ? (
            <ResizablePanelGroup
              direction="horizontal"
              autoSaveId="app-shell-dock"
              className="flex-1 min-h-0"
            >
              <ResizablePanel
                ref={centerPanelRef}
                minSize={30}
                collapsible
                collapsedSize={0}
                className="flex flex-col min-w-0"
              >
                {center}
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel
                defaultSize={40}
                minSize={22}
                // The everyday cap keeps some chat on screen; maximized, the
                // dock *is* the window, and a 70% cap would refuse the collapse
                // outright (the two panels have to sum to 100).
                maxSize={maximized ? 100 : 70}
                className="flex flex-col min-w-0"
              >
                <RightDock
                  workspaceId={workspaceId}
                  tabs={dock.tabs}
                  activeId={dock.activeId}
                  onOpenTab={dock.openTab}
                  onCloseTab={dock.closeTab}
                  onSelectTab={dock.selectTab}
                  onCollapse={() => dock.setCollapsed(true)}
                  maximized={dock.maximized}
                  onSetMaximized={dock.setMaximized}
                />
              </ResizablePanel>
            </ResizablePanelGroup>
          ) : (
            center
          )}
        </div>

        {workspaceId && dock.collapsed && (
          <DockRail onOpen={() => dock.setCollapsed(false)} />
        )}
      </div>
    </SidebarInset>
  )
}
