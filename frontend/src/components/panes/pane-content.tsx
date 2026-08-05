import { Suspense, lazy } from "react"

import { ArtifactsPane } from "@/components/panes/artifacts-pane"
import { ChangesPanel } from "@/components/shell/changes-panel"
import { PreviewPanel } from "@/components/shell/preview-panel"
import { TerminalPanel } from "@/components/shell/terminal-panel"
import type { PaneKind } from "@/components/panes/pane-kinds"
import { WorkspaceChatPage } from "@/pages/chat/workspace-chat-page"

// Usage pulls recharts, Video and Image pull their composers and model rosters.
// None is needed until its pane is opened, and three of the four are reachable
// only from a global layout — so they are split out rather than riding along in
// whatever chunk this module lands in.
const AnalyticsPage = lazy(() =>
  import("@/pages/analytics/analytics-page").then((m) => ({
    default: m.AnalyticsPage,
  }))
)
const VideoPage = lazy(() =>
  import("@/pages/video/video-page").then((m) => ({ default: m.VideoPage }))
)
const ImagePage = lazy(() =>
  import("@/pages/image/image-page").then((m) => ({ default: m.ImagePage }))
)

// Monaco is heavy (~5MB); load the file editor only when a Files pane opens so it
// never weighs down the base app.
const FileViewer = lazy(() =>
  import("@/components/files/file-viewer").then((m) => ({
    default: m.FileViewer,
  }))
)

export interface PaneContentProps {
  kind: PaneKind
  workspaceId?: string
  /** The pane's id — what per-pane state is keyed on (`lib/tab-storage.ts`). */
  paneId: string
  /** Whether this pane is the visible one in its group. */
  active: boolean
  /** A pane-reported detail for the tab (a port, a filename, a conversation name). */
  onDetail?: (detail: string | null) => void
  /** Chat only: the open conversation, and how to report a change to it. */
  threadId?: string | null
  onThreadChange?: (threadId: string | null) => void
  /** Artifacts only: cross-link into the Video or Image pane. */
  onOpenPane?: (kind: "video" | "image") => void
}

/**
 * One pane's body, chosen by kind.
 *
 * The successor to `right-dock`'s `DockPanelContent`, and deliberately the same
 * shape: a switch with an exhaustiveness guard, so a newly added `PaneKind`
 * surfaces as a type error until it gets a branch here rather than silently
 * rendering nothing.
 *
 * It is also what the mobile bottom bar renders, which is why this is a separate
 * module from the dockview host: mobile has no zones, no tab strips and no drag,
 * but it needs exactly this mapping from kind to component.
 */
export function PaneContent({
  kind,
  workspaceId,
  paneId,
  active,
  onDetail,
  threadId,
  onThreadChange,
  onOpenPane,
}: PaneContentProps) {
  if (kind === "chat") {
    return (
      <WorkspaceChatPage
        workspaceId={workspaceId}
        threadId={threadId ?? null}
        onThreadChange={onThreadChange ?? (() => undefined)}
        onDetail={onDetail}
      />
    )
  }
  if (kind === "changes") {
    return <ChangesPanel workspaceId={workspaceId} />
  }
  if (kind === "terminal") {
    return <TerminalPanel workspaceId={workspaceId} paneId={paneId} />
  }
  if (kind === "preview") {
    return (
      <PreviewPanel
        workspaceId={workspaceId}
        tabId={paneId}
        active={active}
        onDetail={onDetail}
      />
    )
  }
  if (kind === "file") {
    return (
      <Suspense
        fallback={
          <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
            Loading editor…
          </div>
        }
      >
        <FileViewer
          workspaceId={workspaceId}
          tabId={paneId}
          active={active}
          onDetail={onDetail}
        />
      </Suspense>
    )
  }

  if (kind === "artifacts") {
    return <ArtifactsPane workspaceId={workspaceId} onOpenPane={onOpenPane} />
  }
  // The three re-hosted pages. Each keeps its own state (a date range, a
  // half-typed prompt) and is `renderer: 'always'` for that reason — see
  // `pane-kinds.ts`. `embedded` drops the page heading, since the tab already
  // names the pane.
  if (kind === "usage" || kind === "video" || kind === "image") {
    const Page =
      kind === "usage" ? AnalyticsPage : kind === "video" ? VideoPage : ImagePage
    return (
      <div className="scrollbar-hover min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <Suspense
          fallback={
            <p className="text-sm text-muted-foreground">Loading…</p>
          }
        >
          <Page embedded />
        </Suspense>
      </div>
    )
  }

  // A real exhaustiveness guard, not a comment claiming to be one: if a new
  // `PaneKind` is added without a branch above, `kind` is no longer `never` and
  // this line fails to compile.
  return assertNever(kind)
}

function assertNever(kind: never): null {
  void kind
  return null
}
