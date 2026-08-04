/**
 * A tiny cross-component channel for "open this conversation" requests.
 *
 * Modelled on {@link requestOpenFile}, and needed for the same reason once chat
 * became a pane. The sidebar used to open a conversation by navigating — `?c=` was
 * the source of truth and the single chat surface read it. Panes address
 * themselves through their own params instead (the plan's §4: the URL is written
 * *from* the focused pane, not read to build the layout), so there is no longer a
 * URL path from a sidebar row down to the pane that should answer it.
 *
 * A row parks a request here; the shell routes it to a chat pane using the same
 * active → most-recently-used → leftmost rule every other open request follows, so
 * a conversation lands in the chat you are actually looking at rather than in one
 * you forgot was open.
 */
export interface OpenThreadRequest {
  workspaceId: string
  threadId: string
}

let pending: OpenThreadRequest | null = null
const listeners = new Set<() => void>()

/** Park a request and notify subscribers. */
export function requestOpenThread(request: OpenThreadRequest): void {
  pending = request
  for (const listener of listeners) listener()
}

/** Look at the pending request without clearing it. */
export function peekPendingThread(): OpenThreadRequest | null {
  return pending
}

/**
 * Take the pending request if it targets `workspaceId`, clearing it so it opens
 * exactly once. Returns null when there is nothing for this workspace.
 */
export function consumePendingThread(
  workspaceId: string | undefined
): OpenThreadRequest | null {
  if (pending && workspaceId && pending.workspaceId === workspaceId) {
    const request = pending
    pending = null
    return request
  }
  return null
}

/** Subscribe to request changes; returns an unsubscribe. */
export function subscribeOpenThread(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
