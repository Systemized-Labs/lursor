import { Outlet, useLocation } from "react-router-dom"

import { AppSidebar } from "@/components/layout/app-sidebar"
import { DockRail } from "@/components/shell/dock-rail"
import { RightDock } from "@/components/shell/right-dock"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { useDockState } from "@/hooks/use-dock-state"
import { useIsMobile } from "@/hooks/use-mobile"

/**
 * The persistent app shell: a Cursor-style collapsible sidebar, the routed
 * center content, and a resizable right-side dock. A slim inset header carries
 * the sidebar toggle and (when the dock is hidden) a re-open affordance.
 *
 * The dock is a side-by-side split, so on phones it would crush the content —
 * there it collapses and the center takes the full width.
 */
export function AppShell() {
  const isMobile = useIsMobile()
  const { pathname } = useLocation()
  // The active workspace (from `/workspaces/:id/...`) keys the dock's persisted
  // layout, so each workspace remembers whether its dock is open and which
  // panels were up.
  const workspaceId = pathname.match(/\/workspaces\/([^/]+)/)?.[1]
  const dock = useDockState(workspaceId)
  const dockVisible = !isMobile && !dock.collapsed

  // Full-bleed surfaces (e.g. a chat thread) manage their own scroll and fill
  // the panel edge to edge; everything else keeps the padded, centered column.
  const fullBleed = pathname.includes("/threads/") || pathname.endsWith("/chat")

  // Full-bleed surfaces must fill exactly the viewport so their inner regions
  // (e.g. a chat message list) scroll independently. The sidebar shell is only
  // `min-h-svh` (a floor that grows with content), so `flex-1`/`min-h-0` have no
  // definite height to cap against — pin a concrete `h-svh` here instead.
  const center = fullBleed ? (
    <main className="h-svh min-w-0 flex flex-col overflow-hidden">
      <Outlet />
    </main>
  ) : (
    <main className="flex-1 min-w-0 overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
        <Outlet />
      </div>
    </main>
  )

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        {/* Mobile-only floating trigger to open the off-canvas sidebar (the
            sidebar's own toggle is off-screen while it's collapsed on phones). */}
        <SidebarTrigger className="absolute left-2 top-2 z-40 h-8 w-8 rounded-md border border-border bg-background/80 shadow-sm backdrop-blur md:hidden" />

        {/* A horizontal row: the content area (with its optional dock split) and
            a thin, always-present rail whose toggle governs the dock. The rail
            owns a real column, so its toggle never overlaps page content. */}
        <div className="flex flex-1 min-h-0">
          <div className="flex flex-1 flex-col min-w-0">
            {dockVisible ? (
              <ResizablePanelGroup
                direction="horizontal"
                autoSaveId="app-shell-dock"
                className="flex-1 min-h-0"
              >
                <ResizablePanel minSize={30} className="flex flex-col min-w-0">
                  {center}
                </ResizablePanel>
                <ResizableHandle withHandle />
                <ResizablePanel
                  defaultSize={40}
                  minSize={22}
                  maxSize={70}
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
                  />
                </ResizablePanel>
              </ResizablePanelGroup>
            ) : (
              center
            )}
          </div>

          {!isMobile && dock.collapsed && (
            <DockRail onOpen={() => dock.setCollapsed(false)} />
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}
