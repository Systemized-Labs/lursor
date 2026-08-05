import { createRequestChannel } from "@/lib/request-channel"

/**
 * A tiny cross-component channel for "open this file" requests.
 *
 * The file editor ({@link FileViewer}) owns its own open-tab state and only
 * mounts when a "file" pane exists, so there's no prop path from the global
 * command palette down to it. Instead the palette parks a pending request here;
 * the app shell notices it (ensuring a Files pane for the right workspace) and the
 * viewer consumes it once mounted.
 *
 * The plumbing is {@link createRequestChannel}; what is specific to files is the
 * request below and the reason above.
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

/**
 * The channel itself, for the shell's {@link usePendingRequest}.
 *
 * Exported alongside the four functions rather than instead of them: a requester
 * reads better as `requestOpenFile(...)` than as `openFileChannel.request(...)`, and
 * there are eleven of those. The receiving side needs the object, because it takes
 * the channel as a parameter.
 */
export const openFileChannel = createRequestChannel<OpenFileRequest>()
const channel = openFileChannel

export const requestOpenFile = channel.request
export const peekPendingFile = channel.peek
export const consumePendingFile = channel.consume
export const subscribeOpenFile = channel.subscribe
