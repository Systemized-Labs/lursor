/**
 * A tiny cross-component channel for "open this URL in the preview panel"
 * requests — the in-app "Lursor Browser".
 *
 * The preview pane ({@link PreviewPanel}) owns its own address/URL state and only
 * mounts when a "preview" dock tab exists, so there's no prop path from a chat
 * link's context menu down to it. Instead the menu parks a pending request here;
 * the app shell notices it (opening the dock + a preview tab for the right
 * workspace) and the panel consumes it once mounted. Mirrors {@link ./open-file}.
 */
export interface OpenPreviewRequest {
  workspaceId: string
  url: string
}

let pending: OpenPreviewRequest | null = null
const listeners = new Set<() => void>()

/** Park a request and notify subscribers. The shell/panel pick it up. */
export function requestOpenPreview(request: OpenPreviewRequest): void {
  pending = request
  for (const listener of listeners) listener()
}

/** Look at the pending request without clearing it. */
export function peekPendingPreview(): OpenPreviewRequest | null {
  return pending
}

/**
 * Take the pending request if it targets `workspaceId`, clearing it so it opens
 * exactly once. Returns null when there's nothing for this workspace.
 */
export function consumePendingPreview(
  workspaceId: string | undefined
): OpenPreviewRequest | null {
  if (pending && workspaceId && pending.workspaceId === workspaceId) {
    const request = pending
    pending = null
    return request
  }
  return null
}

/** Subscribe to request changes; returns an unsubscribe. */
export function subscribeOpenPreview(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
