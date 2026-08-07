import { useMutation } from "@tanstack/react-query"

import { api } from "./client"

/**
 * The Assistant's one endpoint.
 *
 * There is nothing here for chat or for conversation history: the Assistant is
 * backed by a real workspace with real threads, so `useThreads`, the sidebar and
 * `POST /threads/{id}/chat` already cover all of it. That is the whole reason it
 * is a pinned sidebar row rather than a modal — past conversations come for free
 * instead of needing their own list.
 *
 * What is left is the answer to a destructive action's confirmation card, which
 * unblocks the tool awaiting it (`backend/app/assistant/confirm.py`).
 */
export const assistantApi = {
  confirm: (token: string, approved: boolean) =>
    api.post<void>(`/assistant/confirm/${token}`, { approved }),
}

export function useConfirmAction() {
  return useMutation({
    mutationFn: ({ token, approved }: { token: string; approved: boolean }) =>
      assistantApi.confirm(token, approved),
  })
}
