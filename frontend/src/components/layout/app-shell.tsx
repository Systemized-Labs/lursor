import { useEffect, useRef, useState } from "react"
import { Outlet, useLocation } from "react-router-dom"

import { AppSidebar } from "@/components/layout/app-sidebar"
import { CommandPaletteProvider } from "@/components/command-palette/command-palette"
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
import {
  peekPendingFile,
  subscribeOpenFile,
  type OpenFileRequest,
} from "@/lib/open-file"

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
  // The dock is workspace-scoped (changes/files/terminal for a repo), so it
  // only makes sense inside a workspace route — not on the New Agent home,
  // Customization, or Settings surfaces.
  const dockVisible = !isMobile && !dock.collapsed && Boolean(workspaceId)

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
    dock.setCollapsed(false)
    if (!dock.tabs.some((t) => t.kind === "file")) dock.openTab("file")
  }, [openFileTick, workspaceId, dock])

  // Full-bleed surfaces (e.g. a chat thread) manage their own scroll and fill
  // the panel edge to edge; everything else keeps the padded, centered column.
  const fullBleed =
    pathname === "/" ||
    pathname.includes("/threads/") ||
    pathname.endsWith("/chat")

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
      <CommandPaletteProvider>
      <AppSidebar />
      {/* `min-w-0` lets this flex child shrink below its content's intrinsic
          width; without it, widening the dock grows the whole inset past the
          viewport instead of redistributing space within it. */}
      <SidebarInset className="min-w-0">
        {/* Mobile-only floating trigger to open the off-canvas sidebar (the
            sidebar's own toggle is off-screen while it's collapsed on phones). */}
        <SidebarTrigger className="absolute left-2 top-2 z-40 h-8 w-8 rounded-md border border-border bg-background/80 shadow-sm backdrop-blur md:hidden" />

        {/* A horizontal row: the content area (with its optional dock split) and
            a thin, always-present rail whose toggle governs the dock. The rail
            owns a real column, so its toggle never overlaps page content.

            The row is pinned to a concrete `h-svh` (the sidebar shell is only
            `min-h-svh`, a floor that grows with content). Without a definite
            height here, `flex-1`/`min-h-0` descendants have nothing to cap
            against, so a tall panel — e.g. a large Changes diff in the dock —
            would grow the whole inset and overflow the viewport instead of
            scrolling internally. `overflow-hidden` clips at the row so the split
            below always resolves its own scroll. */}
        <div className="flex h-svh min-h-0 overflow-hidden">
          <div className="flex flex-1 flex-col min-w-0 min-h-0">
            {dockVisible ? (
              <ResizablePanelGroup
                direction="horizontal"
                autoSaveId="app-shell-dock"
                className="flex-1 min-h-0"
              >
                <ResizablePanel minSize={30} className="flex flex-col min-w-0">
                  {center}
                </ResizablePanel>
                <ResizableHandle />
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

          {!isMobile && workspaceId && dock.collapsed && (
            <DockRail onOpen={() => dock.setCollapsed(false)} />
          )}
        </div>
      </SidebarInset>
      </CommandPaletteProvider>
    </SidebarProvider>
  )
}
