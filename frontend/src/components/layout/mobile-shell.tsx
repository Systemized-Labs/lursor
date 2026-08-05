import { Outlet } from "react-router-dom"

import { AppSidebar } from "@/components/layout/app-sidebar"
import { WindowBar } from "@/components/layout/window-bar"
import { PaneContent } from "@/components/panes/pane-content"
import { PANE_KINDS, type MobilePaneKind, type PaneKind } from "@/components/panes/pane-kinds"
import { SettingsDialog } from "@/components/settings/settings-dialog"
import { CommandPaletteProvider } from "@/components/command-palette/command-palette"
import { MobileDockBar } from "@/components/shell/mobile-dock-bar"
import { MobilePlanView } from "@/components/shell/mobile-plan-view"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"

/**
 * The shell's padded content column, for a route that is still a page.
 *
 * Lives here rather than in `app-shell` because both branches need it and the shell
 * imports this module already — the other direction would be a cycle. Two copies of
 * the same Tailwind string in two files is exactly the drift this pass is about.
 */
export const CONTENT_COLUMN = "mx-auto w-full max-w-6xl"

/** Which full-screen surface the bottom bar has switched to. */
export type MobileView = "chat" | "plan" | MobilePaneKind

interface MobileShellProps {
  workspaceId: string | undefined
  /** A full-bleed route (the New Agent launcher) manages its own scroll. */
  fullBleed: boolean
  /** Set when the current path is an address for a pane rather than a page. */
  paneRoute: { path: string; kind: PaneKind } | undefined
  inWorkspace: boolean
  /** `?c=`, which on a phone is what the single chat surface reads. */
  threadId: string | null
  onThreadChange: (threadId: string | null) => void
  /** The WindowBar's title for a route, before the bottom bar overrides it. */
  routeTitle: string
  view: MobileView
  /** Kinds mounted so far. See the note on layering below. */
  visitedKinds: MobilePaneKind[]
  /** The kinds this workspace's saved layout holds, for the bottom bar. */
  barKinds: MobilePaneKind[]
  /** The plan doc surfaced for a parked `/plan` turn, if any. */
  plan: { path: string } | null
  onShowChat: () => void
  onShowKind: (kind: MobilePaneKind) => void
  onShowPlan: () => void
  onOpenSettings: () => void
  onOpenLayouts: () => void
}

/**
 * The phone shell: a WindowBar, one full-screen surface at a time, and the bottom
 * bar that switches between them.
 *
 * **The pane layer is not used here at all.** A four-zone grid on a 390px screen is
 * not a layout, so mobile renders the same {@link PaneContent} the panes do — just
 * without zones, tabs or drag. Which is also why this tree takes `view` and
 * `visitedKinds` as props: the state belongs to the shell, because the shell is what
 * resets it on a workspace switch and what routes parked open-requests into it.
 *
 * Split out of `app-shell` in the layout cleanup pass. It is a render tree and
 * nothing else — no effects, no state — and the shell keeps the routing, the pane
 * layout wiring and the desktop tree.
 */
export function MobileShell({
  workspaceId,
  fullBleed,
  paneRoute,
  inWorkspace,
  threadId,
  onThreadChange,
  routeTitle,
  view,
  visitedKinds,
  barKinds,
  plan,
  onShowChat,
  onShowKind,
  onShowPlan,
  onOpenSettings,
  onOpenLayouts,
}: MobileShellProps) {
  const center = fullBleed ? (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <Outlet />
    </main>
  ) : paneRoute ? (
    // These routes have no element — the desktop shell answers them with a pane.
    // A phone has no pane layer, so it renders the same surface full-screen
    // through the same kind→component map.
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <PaneContent
        kind={paneRoute.kind}
        workspaceId={workspaceId}
        paneId={`mobile-route-${paneRoute.kind}`}
        active
      />
    </main>
  ) : inWorkspace ? (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <PaneContent
        kind="chat"
        workspaceId={workspaceId}
        paneId={`mobile-${workspaceId}-chat`}
        active
        threadId={threadId}
        onThreadChange={onThreadChange}
      />
    </main>
  ) : (
    <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div
        className={cn(
          CONTENT_COLUMN,
          "px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
        )}
      >
        <Outlet />
      </div>
    </main>
  )

  const title =
    view === "chat" ? routeTitle : view === "plan" ? "Plan" : PANE_KINDS[view].title

  return (
    <SidebarProvider>
      <CommandPaletteProvider>
        <AppSidebar />
        <SidebarInset className="min-w-0">
          <div className="flex h-svh min-h-0 flex-col overflow-hidden">
            <WindowBar
              onOpenSettings={onOpenSettings}
              onOpenLayouts={onOpenLayouts}
              title={title}
            />

            {/* Stacked full-screen views — only the active one is shown.
                Layering (rather than conditional mount) keeps each surface's
                state alive when the bottom bar switches away from it. */}
            <div className="relative min-h-0 flex-1">
              <div
                className={cn(
                  "absolute inset-0 flex flex-col",
                  view !== "chat" && "hidden"
                )}
              >
                {center}
              </div>
              {workspaceId &&
                visitedKinds.map((kind) => (
                  <div
                    key={kind}
                    className={cn(
                      "absolute inset-0 flex min-h-0 flex-col bg-background",
                      view !== kind && "hidden"
                    )}
                  >
                    {/* One surface per kind here — the bottom bar has no notion
                        of duplicates — so a fixed id stands in for a pane id.
                        Scoped by workspace: these are not remounted on a
                        workspace switch, and per-pane storage is global, so a
                        shared id would carry the last repo's preview URL over. */}
                    <PaneContent
                      kind={kind}
                      workspaceId={workspaceId}
                      paneId={`mobile-${workspaceId}-${kind}`}
                      active={view === kind}
                    />
                  </div>
                ))}
              {workspaceId && (
                <div
                  className={cn(
                    "absolute inset-0 flex min-h-0 flex-col bg-background",
                    view !== "plan" && "hidden"
                  )}
                >
                  <MobilePlanView workspaceId={workspaceId} path={plan?.path} />
                </div>
              )}
            </div>
            {workspaceId && (
              <MobileDockBar
                kinds={barKinds}
                activeKind={view === "chat" || view === "plan" ? null : view}
                planActive={view === "plan"}
                onSelectChat={onShowChat}
                onSelectKind={onShowKind}
                onSelectPlan={onShowPlan}
              />
            )}
          </div>
          <SettingsDialog />
        </SidebarInset>
      </CommandPaletteProvider>
    </SidebarProvider>
  )
}
