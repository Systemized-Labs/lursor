/**
 * A tiny cross-component channel for "open this file" requests.
 *
 * The file editor ({@link FileViewer}) owns its own open-tab state and only
 * mounts when a "file" dock tab exists, so there's no prop path from the global
 * command palette down to it. Instead the palette parks a pending request here;
 * the app shell notices it (opening the dock + a file tab for the right
 * workspace) and the viewer consumes it once mounted.
 */
export interface OpenFileRequest {
  workspaceId: string
  path: string
  name: string
  /**
   * Where in the file to land, 1-based. Set by anything that knows a position and
   * not just a file — a search hit today; a chat citation or a stack-trace frame
   * next. The viewer scrolls there and selects `length` characters once the buffer
   * is up, then forgets the request, so a later re-render can't drag the cursor
   * back.
   */
  line?: number
  column?: number
  length?: number
}

let pending: OpenFileRequest | null = null
const listeners = new Set<() => void>()

/** Park a request and notify subscribers. The shell/viewer pick it up. */
export function requestOpenFile(request: OpenFileRequest): void {
  pending = request
  for (const listener of listeners) listener()
}

/** Look at the pending request without clearing it. */
export function peekPendingFile(): OpenFileRequest | null {
  return pending
}

/**
 * Take the pending request if it targets `workspaceId`, clearing it so it opens
 * exactly once. Returns null when there's nothing for this workspace.
 */
export function consumePendingFile(
  workspaceId: string | undefined
): OpenFileRequest | null {
  if (pending && workspaceId && pending.workspaceId === workspaceId) {
    const request = pending
    pending = null
    return request
  }
  return null
}

/** Subscribe to request changes; returns an unsubscribe. */
export function subscribeOpenFile(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
