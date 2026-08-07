import { createRequestChannel } from "@/lib/request-channel"

/**
 * A tiny cross-component channel for "post this text into the open chat"
 * requests — today the commit summary the Changes panel produces after a
 * successful "Commit & Push".
 *
 * The Changes panel and the chat page are sibling dockview panes with no prop
 * path between them, so the panel parks the summary here; the app shell
 * notices it and focuses the open chat pane (without consuming), and the
 * now-visible chat page consumes it and sends the text as a turn — the
 * open-file flow with "send a turn" in place of "open a file".
 *
 * One parked request at a time is right here as it is everywhere: two commits
 * in rapid succession should post the *latest* summary, not queue both.
 */
export interface SendToChatRequest {
  workspaceId: string
  /** The message text to send as a chat turn (the commit summary). */
  text: string
}

/** The channel itself, for the shell's `usePendingRequest`. See `open-file`. */
export const sendToChatChannel = createRequestChannel<SendToChatRequest>()
const channel = sendToChatChannel

export const requestSendToChat = channel.request
export const peekPendingSendToChat = channel.peek
export const consumePendingSendToChat = channel.consume
export const subscribeSendToChat = channel.subscribe
