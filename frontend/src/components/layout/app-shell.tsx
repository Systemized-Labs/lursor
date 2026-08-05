import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type { CSSProperties, ReactNode } from "react"
import { Outlet, useLocation, useSearchParams } from "react-router-dom"

import { useWorkspace } from "@/api/workspaces"
import { AppSidebar } from "@/components/layout/app-sidebar"
import { destinationFor } from "@/components/layout/destinations"
import {
  CONTENT_COLUMN,
  MobileShell,
  type MobileView,
} from "@/components/layout/mobile-shell"
import { useSidebarSide } from "@/components/layout/use-sidebar-side"
import { WINDOW_BAR_HEIGHT, WindowBar } from "@/components/layout/window-bar"
import type { MobilePaneKind, PaneKind } from "@/components/panes/pane-kinds"
import {
  hasStoredLayout,
  readLayoutKinds,
  usePaneLayout,
} from "@/components/panes/use-pane-layout"
import { SettingsDialog } from "@/components/settings/settings-dialog"
import { useSettingsParam } from "@/components/settings/use-settings-param"
import { CommandPaletteProvider } from "@/components/command-palette/command-palette"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { useIsMobile } from "@/hooks/use-mobile"
import { usePendingRequest } from "@/hooks/use-pending-request"
import { usePreviewWatch } from "@/hooks/use-preview-watch"
import { useTerminalPrewarm } from "@/hooks/use-terminal-prewarm"
import { cn } from "@/lib/utils"
import {
  consumePendingFile,
  openFileChannel,
  type OpenFileRequest,
} from "@/lib/open-file"
import { isPlanFile } from "@/lib/plan-doc"
import { openPreviewChannel } from "@/lib/open-preview"
import {
  consumePendingThread,
  openThreadChannel,
  type OpenThreadRequest,
} from "@/lib/open-thread"

/**
 * Dockview is ~77KB gzipped and only ever needed inside a workspace, so the host
 * is code-split behind that — exactly the arrangement the plan's §3.4 asks for, and
 * the one Phase 0 measured at +213 bytes to the entry chunk. `use-pane-layout` is
 * imported eagerly and must therefore stay free of dockview *value* imports; see
 * the note on `HORIZONTAL` there.
 */
const PaneHost = lazy(() =>
  import("@/components/panes/pane-host").then((m) => ({ default: m.PaneHost }))
)

/**
 * Routes that are *addresses for a pane*, not pages.
 *
 * Same move Phase 4 made for chat: the route resolves so links and bookmarks keep
 * working, and arriving on it ensures the corresponding pane in the layout. Which
 * layout depends on where you are — inside a workspace these join that workspace's
 * arrangement, outside one they join the global `_global` layout §3.6 describes.
 */
const PANE_ROUTES: { path: string; kind: PaneKind }[] = [
  { path: "/analytics", kind: "usage" },
  { path: "/video", kind: "video" },
  { path: "/image", kind: "image" },
  { path: "/artifacts", kind: "artifacts" },
]

/** Same reasoning: it imports dockview types *and* `fromJSON`, so it goes too. */
const LayoutsDialog = lazy(() =>
  import("@/components/panes/layouts-dialog").then((m) => ({
    default: m.LayoutsDialog,
  }))
)

/**
 * The persistent app shell: the WindowBar, the sessions sidebar, and — inside a
 * workspace — the pane layer.
 *
 * Outside a workspace the centre is still the routed `Outlet`: Usage, Video and
 * Image are whole pages until Phase 6 re-hosts them as panes, and the New Agent
 * home is a full-bleed launcher rather than a pane.
 *
 * On phones the pane layer is not used at all. A four-zone grid on a 390px screen
 * is not a layout, so mobile keeps the bottom bar that swaps one full-screen
 * surface for another — rendering the same {@link PaneContent} the panes do, just
 * without zones, tabs or drag.
 */
export function AppShell() {
  const isMobile = useIsMobile()
  const { pathname } = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const { openSettings } = useSettingsParam()
  const [sidebarSide, setSidebarSide] = useSidebarSide()
  const [layoutsOpen, setLayoutsOpen] = useState(false)
  // The active workspace (from `/workspaces/:id/...`) keys the pane layout, so
  // each workspace remembers its own arrangement.
  const workspaceId = pathname.match(/\/workspaces\/([^/]+)/)?.[1]
  const layout = usePaneLayout(workspaceId)
  // Keep the detected dev-server list live for the active workspace, so servers
  // the agent starts are known even before a Preview pane is opened.
  usePreviewWatch(workspaceId)
  // Start this workspace's shell now, so the first Terminal pane attaches to one
  // that is already past its rc files instead of waiting seconds for a prompt.
  useTerminalPrewarm(workspaceId)
  // Workspace name feeds the mobile header title (cached — the chat pane shares
  // this query).
  const workspaceForTitle = useWorkspace(workspaceId)
  const inWorkspace = Boolean(workspaceId)
  const paneRoute = PANE_ROUTES.find((entry) => pathname === entry.path)
  // The pane layer is the centre for a workspace, and for the four surfaces that
  // are panes without one. Everything else — the New Agent launcher — is still a
  // routed page, because a full-bleed launcher is not a pane.
  const showPanes = inWorkspace || paneRoute !== undefined

  /**
   * `?c=` is written *from* the focused chat pane, never read to build the layout
   * (the plan's §4). It stays in the URL so a conversation is still linkable and
   * still survives a reload — routing degrades from owner to address.
   */
  const setFocusedThread = useCallback(
    (threadId: string | null) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (threadId) next.set("c", threadId)
          else next.delete("c")
          return next
        },
        { replace: true }
      )
    },
    [setSearchParams]
  )

  // On mobile the bottom bar switches the centre view in place (like tabs).
  // Surfaces are mounted on first visit and kept alive (hidden) when switched
  // away, so a terminal session or editor buffer survives a tab switch — the same
  // guarantee `renderer: 'always'` gives the panes on desktop.
  const [mobileView, setMobileView] = useState<MobileView>("chat")
  const [visitedKinds, setVisitedKinds] = useState<MobilePaneKind[]>([])
  // The plan doc surfaced for this workspace's parked `/plan` turn, if any. The
  // Files editor is desktop-only, so on mobile a plan opens in a read-only
  // Markdown view instead (see the open-file effect below).
  const [mobilePlan, setMobilePlan] = useState<{ path: string } | null>(null)

  /**
   * The pane kinds this workspace's layout holds, for the bottom bar.
   *
   * Read from storage rather than from `layout.api`: the pane layer never mounts
   * on a phone, so there is no dockview instance to ask. Recomputed when the
   * workspace changes, which is the only time it can change without a desktop
   * session in between.
   */
  const mobileKinds = useMemo<MobilePaneKind[]>(() => {
    if (!isMobile || !workspaceId) return []
    return readLayoutKinds(workspaceId).filter(
      (kind): kind is MobilePaneKind => kind !== "chat"
    )
  }, [isMobile, workspaceId])

  const showMobilePaneKind = useCallback((kind: MobilePaneKind) => {
    setVisitedKinds((prev) => (prev.includes(kind) ? prev : [...prev, kind]))
    setMobileView(kind)
  }, [])

  // Leaving a workspace (or switching to desktop) snaps back to the chat view
  // and forgets which surfaces were mounted for the previous repo.
  useEffect(() => {
    if (!workspaceId || !isMobile) {
      setMobileView("chat")
      setVisitedKinds([])
      setMobilePlan(null)
    }
  }, [workspaceId, isMobile])

  // First visit to the Skill Studio: open a Files pane. Its whole point is the
  // tree over every skill, and a lone chat hides that the panes are even there.
  // Only when nothing is stored for this workspace — after that the layout is the
  // user's.
  const seededRef = useRef<string | null>(null)
  useEffect(() => {
    const isStudio = workspaceForTitle.data?.is_system === true
    if (!isStudio || !workspaceId || isMobile || !layout.api) return
    if (seededRef.current === workspaceId) return
    seededRef.current = workspaceId
    if (hasStoredLayout(workspaceId)) return
    layout.openPane("file")
  }, [workspaceForTitle.data?.is_system, workspaceId, isMobile, layout])

  /**
   * Whether this shell can answer a parked open request yet.
   *
   * On desktop that means dockview exists: the pane host is lazy, and a request
   * handled before it mounts is marked handled by a handler that can do nothing —
   * `ensurePane` and `openThread` both begin `if (!api) return`, so the request would
   * be dropped without opening and never consumed.
   *
   * A phone is always ready, and that is not the same condition: there is no pane
   * layer on mobile at all, so `layout.api` is null for the whole session. Gating on
   * it there would mean a plan doc never reaches {@link MobilePlanView} and the
   * bottom bar never switches for a preview.
   */
  const canOpen = isMobile || layout.api !== null

  // Global "open this conversation" requests (a sidebar row, a link in a reply).
  // Chat is a pane now, so a click cannot address it through `?c=` — see
  // `lib/open-thread.ts`.
  const handleOpenThread = useCallback(
    (request: OpenThreadRequest) => {
      consumePendingThread(workspaceId)
      if (isMobile) {
        // No panes on a phone: the single chat surface reads `?c=`, which the
        // requester's own navigation has already set — or cleared, which is how a
        // new session still reaches it here. Switching to chat is ours to do —
        // tapping a conversation while looking at the terminal means show me the
        // conversation.
        setMobileView("chat")
        return
      }
      layout.openThread(request.threadId)
    },
    [workspaceId, isMobile, layout]
  )
  usePendingRequest(openThreadChannel, workspaceId, canOpen, handleOpenThread)

  /**
   * A `?c=` arriving from outside the pane layer — a bookmark, a reload, a link
   * pasted into the address bar — addresses the chat pane once per workspace load.
   *
   * This is the *only* place the URL is read to position a pane, and it is
   * consistent with §4: the URL is the address. Once per load, because after that
   * the panes own their own addressing and re-reading `?c=` would drag a second
   * chat pane back onto the first one's thread.
   */
  const seededThreadFor = useRef<string | null>(null)
  useEffect(() => {
    if (isMobile || !layout.api || !workspaceId) return
    if (seededThreadFor.current === workspaceId) return
    const wanted = searchParams.get("c")
    seededThreadFor.current = workspaceId
    if (wanted) layout.openThread(wanted)
  }, [workspaceId, layout, isMobile, searchParams])

  /**
   * Arriving on a pane route ensures its pane, once.
   *
   * Guarded on the path rather than the pane's existence: `ensurePane` already
   * focuses an open one instead of adding a second, and re-running on every render
   * would fight the user the moment they focused something else.
   */
  const addressedRoute = useRef<string | null>(null)
  useEffect(() => {
    if (isMobile || !layout.api || !paneRoute) return
    if (addressedRoute.current === paneRoute.path) return
    addressedRoute.current = paneRoute.path
    layout.ensurePane(paneRoute.kind)
  }, [paneRoute, layout, isMobile])
  useEffect(() => {
    if (!paneRoute) addressedRoute.current = null
  }, [paneRoute])

  // Global "open this file" requests (from the command palette) land here: once
  // we're on the target workspace, ensure a Files pane so the editor mounts and
  // can pick the request up. Left parked rather than consumed — the viewer is what
  // knows the file is open, so it takes it.
  const handleOpenFile = useCallback(
    (request: OpenFileRequest) => {
      // The Monaco editor is desktop-only, so on mobile the FileViewer never mounts
      // to consume this request. Plan docs are the exception: route them to the
      // read-only mobile plan view (consuming the request ourselves so it doesn't
      // linger). Any other file has nowhere to go on a phone — leave it.
      if (isMobile) {
        if (isPlanFile(request.name)) {
          consumePendingFile(workspaceId)
          setMobilePlan({ path: request.path })
          setMobileView("plan")
        }
        return
      }
      layout.ensurePane("file")
    },
    [isMobile, workspaceId, layout]
  )
  usePendingRequest(openFileChannel, workspaceId, canOpen, handleOpenFile)

  // Global "open this URL in the preview" requests (from the right-click menu on
  // chat links): reveal a Preview surface for the target workspace so the panel
  // mounts and navigates. The panel consumes the request itself, so the URL is
  // still there when it comes up.
  const handleOpenPreview = useCallback(() => {
    if (isMobile) {
      showMobilePaneKind("preview")
      return
    }
    layout.ensurePane("preview")
  }, [isMobile, layout, showMobilePaneKind])
  usePendingRequest(openPreviewChannel, workspaceId, canOpen, handleOpenPreview)

  // Full-bleed surfaces (e.g. the New Agent launcher) manage their own scroll and
  // fill the panel edge to edge; everything else keeps the padded column.
  const fullBleed = pathname === "/"

  // ── Mobile layout ──────────────────────────────────────────────────────────
  if (isMobile) {
    return (
      <MobileShell
        workspaceId={workspaceId}
        fullBleed={fullBleed}
        paneRoute={paneRoute}
        inWorkspace={inWorkspace}
        threadId={searchParams.get("c")}
        onThreadChange={setFocusedThread}
        routeTitle={
          destinationFor(pathname)?.label ??
          (workspaceId ? (workspaceForTitle.data?.name ?? "Workspace") : "New chat")
        }
        view={mobileView}
        visitedKinds={visitedKinds}
        barKinds={mobileKinds}
        plan={mobilePlan}
        onShowChat={() => setMobileView("chat")}
        onShowKind={showMobilePaneKind}
        onShowPlan={() => setMobileView("plan")}
        onOpenSettings={openSettings}
        onOpenLayouts={() => setLayoutsOpen(true)}
      />
    )
  }

  // ── Desktop layout ─────────────────────────────────────────────────────────
  const center: ReactNode = fullBleed ? (
    <main className="flex h-(--shell-height) min-w-0 flex-1 flex-col overflow-hidden">
      <Outlet />
    </main>
  ) : (
    <main className="min-w-0 flex-1 overflow-y-auto">
      <div className={cn(CONTENT_COLUMN, "px-4 py-6 sm:px-6")}>
        <Outlet />
      </div>
    </main>
  )

  return (
    /* A column, not the primitive's default row: the WindowBar is the frame's own
       strip and everything else lives under it. `--sidebar-top` is how the fixed
       sidebar box and every `--shell-height` consumer learn that the viewport now
       starts 44px down. */
    <SidebarProvider
      className="h-svh flex-col overflow-hidden"
      style={{ "--sidebar-top": WINDOW_BAR_HEIGHT } as CSSProperties}
    >
      <CommandPaletteProvider>
        <WindowBar
          onOpenSettings={openSettings}
          onOpenLayouts={() => setLayoutsOpen(true)}
        />
        {/* The sidebar swaps sides by DOM order, not `row-reverse`: reversing a
            flex row leaves tab order and screen-reader order pointing the old way,
            so the sidebar would be *read* after the content while appearing before
            it. `side` also has to reach the primitive, which decides whether its
            fixed box anchors left or right. */}
        <div className="flex min-h-0 w-full flex-1">
          {sidebarSide === "left" ? <AppSidebar side="left" /> : null}
          {/* `min-w-0` lets this flex child shrink below its content's intrinsic
              width; without it, widening a pane grows the whole inset past the
              viewport instead of redistributing space within it.

              The row is pinned to a concrete `--shell-height` — the viewport minus
              the WindowBar. Without a definite height, `flex-1`/`min-h-0`
              descendants have nothing to cap against, and dockview in particular
              needs a real box to measure its zones against. */}
          <SidebarInset className="min-w-0">
            <div className="flex h-(--shell-height) min-h-0 overflow-hidden">
              {showPanes ? (
                <Suspense fallback={<div className="flex-1 bg-background" />}>
                  <PaneHost
                    workspaceId={workspaceId}
                    layout={layout}
                    onFocusedThreadChange={setFocusedThread}
                  />
                </Suspense>
              ) : (
                center
              )}
            </div>
          </SidebarInset>
          {sidebarSide === "right" ? <AppSidebar side="right" /> : null}
        </div>
        {/* Mounted at the shell, not per route: settings opens *over* whatever you
            were doing rather than replacing it. */}
        <SettingsDialog />
        {layoutsOpen ? (
          <Suspense fallback={null}>
            <LayoutsDialog
              open={layoutsOpen}
              onOpenChange={setLayoutsOpen}
              layout={layout}
              hasPanes={showPanes}
              hasWorkspace={inWorkspace}
              side={sidebarSide}
              onSideChange={setSidebarSide}
            />
          </Suspense>
        ) : null}
      </CommandPaletteProvider>
    </SidebarProvider>
  )
}
