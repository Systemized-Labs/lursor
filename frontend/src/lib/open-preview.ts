import { createRequestChannel } from "@/lib/request-channel"

/**
 * A tiny cross-component channel for "open this URL in the preview panel"
 * requests — the in-app "Lursor Browser".
 *
 * The preview pane ({@link PreviewPanel}) owns its own address/URL state and only
 * mounts when a "preview" pane exists, so there's no prop path from a chat
 * link's context menu down to it. Instead the menu parks a pending request here;
 * the app shell notices it (ensuring a Preview pane for the right workspace) and the
 * panel consumes it once mounted. Mirrors {@link ./open-file}.
 */
export interface OpenPreviewRequest {
  workspaceId: string
  url: string
}

/** The channel itself, for the shell's `usePendingRequest`. See `open-file`. */
export const openPreviewChannel = createRequestChannel<OpenPreviewRequest>()
const channel = openPreviewChannel

export const requestOpenPreview = channel.request
export const peekPendingPreview = channel.peek
export const consumePendingPreview = channel.consume
export const subscribeOpenPreview = channel.subscribe
