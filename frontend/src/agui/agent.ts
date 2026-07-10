import { HttpAgent } from "@ag-ui/client"

import { API_BASE } from "@/api/client"

/**
 * Builds the AG-UI chat endpoint URL for a given thread. The backend speaks the
 * AG-UI protocol at `POST /threads/{thread_id}/chat`.
 */
export function chatUrl(threadId: string): string {
  return `${API_BASE}/threads/${threadId}/chat`
}

/**
 * Creates an AG-UI `HttpAgent` bound to a thread's chat endpoint. Keeping this
 * isolated makes the streaming transport swappable behind `useAgentChat`.
 */
export function createThreadAgent(threadId: string): HttpAgent {
  return new HttpAgent({
    url: chatUrl(threadId),
    threadId,
  })
}
