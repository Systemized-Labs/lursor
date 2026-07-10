import { useState } from "react"
import { Outlet, useLocation } from "react-router-dom"
import { PanelRight } from "lucide-react"

import { AppSidebar } from "@/components/layout/app-sidebar"
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
  const [dockCollapsed, setDockCollapsed] = useState(false)
  const dockVisible = !isMobile && !dockCollapsed

  // Full-bleed surfaces (e.g. a chat thread) manage their own scroll and fill
  // the panel edge to edge; everything else keeps the padded, centered column.
  const fullBleed = pathname.includes("/threads/")

  const center = fullBleed ? (
    <main className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
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

        {/* Re-open the right dock after it's been hidden. */}
        {!isMobile && dockCollapsed && (
          <button
            type="button"
            onClick={() => setDockCollapsed(false)}
            title="Show panel"
            aria-label="Show panel"
            className="absolute right-3 top-3 z-40 rounded-md border border-border bg-background p-1.5 text-muted-foreground shadow-sm hover:bg-accent hover:text-foreground"
          >
            <PanelRight className="h-4 w-4" />
          </button>
        )}

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
              <RightDock onCollapse={() => setDockCollapsed(true)} />
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          center
        )}
      </SidebarInset>
    </SidebarProvider>
  )
}
