import { HttpAgent } from "@ag-ui/client"

import { API_BASE, authHeaders } from "@/api/client"

/**
 * Builds the AG-UI chat endpoint URL for a given thread. The backend speaks the
 * AG-UI protocol at `POST /threads/{thread_id}/chat`.
 */
export function chatUrl(threadId: string): string {
  return `${API_BASE}/threads/${threadId}/chat`
}

/**
 * The reconnect endpoint for a thread's in-flight run. A plain GET SSE stream
 * that replays buffered events then follows the live run.
 */
export function streamUrl(threadId: string): string {
  return `${API_BASE}/threads/${threadId}/stream`
}

/** URL that serves a persisted attachment's bytes for a thread. */
export function mediaUrl(threadId: string, mediaId: string): string {
  return `${API_BASE}/threads/${threadId}/media/${mediaId}`
}

/**
 * Creates an AG-UI `HttpAgent` bound to a thread's chat endpoint. Keeping this
 * isolated makes the streaming transport swappable behind `useChat`.
 */
export function createThreadAgent(threadId: string): HttpAgent {
  return new HttpAgent({
    url: chatUrl(threadId),
    threadId,
    // A remote backend requires the bearer token on the chat POST like any other
    // request. Empty on a local backend, which needs no credential.
    headers: authHeaders(),
  })
}
