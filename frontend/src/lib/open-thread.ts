import { createRequestChannel } from "@/lib/request-channel"

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

/** The channel itself, for the shell's `usePendingRequest`. See `open-file`. */
export const openThreadChannel = createRequestChannel<OpenThreadRequest>()
const channel = openThreadChannel

export const requestOpenThread = channel.request
export const peekPendingThread = channel.peek
export const consumePendingThread = channel.consume
export const subscribeOpenThread = channel.subscribe
