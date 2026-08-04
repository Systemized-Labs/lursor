import { Suspense, lazy } from "react"

import { ChangesPanel } from "@/components/shell/changes-panel"
import { PreviewPanel } from "@/components/shell/preview-panel"
import { TerminalPanel } from "@/components/shell/terminal-panel"
import type { PaneKind } from "@/components/panes/pane-kinds"
import { WorkspaceChatPage } from "@/pages/chat/workspace-chat-page"

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
  /** A pane-reported detail for the tab (a port, a filename). */
  onDetail?: (detail: string | null) => void
  /** Chat only: the open conversation, and how to report a change to it. */
  threadId?: string | null
  onThreadChange?: (threadId: string | null) => void
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
}: PaneContentProps) {
  if (kind === "chat") {
    return (
      <WorkspaceChatPage
        workspaceId={workspaceId}
        threadId={threadId ?? null}
        onThreadChange={onThreadChange ?? (() => undefined)}
      />
    )
  }
  if (kind === "changes") {
    return <ChangesPanel workspaceId={workspaceId} />
  }
  if (kind === "terminal") {
    return <TerminalPanel workspaceId={workspaceId} />
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

  // Every PaneKind above returns, so `kind` is `never` here.
  return null
}
