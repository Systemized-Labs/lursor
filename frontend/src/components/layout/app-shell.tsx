import { useState } from "react"
import { Outlet } from "react-router-dom"
import { PanelRight } from "lucide-react"

import { AppSidebar } from "@/components/layout/app-sidebar"
import { RightDock } from "@/components/shell/right-dock"
import { Button } from "@/components/ui/button"
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
  const [dockCollapsed, setDockCollapsed] = useState(false)
  const dockVisible = !isMobile && !dockCollapsed

  const center = (
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
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
          <SidebarTrigger />
          {!isMobile && dockCollapsed && (
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto h-7 w-7"
              title="Show panel"
              aria-label="Show panel"
              onClick={() => setDockCollapsed(false)}
            >
              <PanelRight className="h-4 w-4" />
            </Button>
          )}
        </header>

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
