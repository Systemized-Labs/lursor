import { useMutation, useQuery } from "@tanstack/react-query"

import { api } from "./client"
import type { Thread } from "./types"

/**
 * The Assistant's own endpoints. Chat itself is *not* here — an Assistant
 * conversation is an ordinary thread and goes through `POST /threads/{id}/chat`
 * like every other run, which is what lets the overlay reuse `useChatEngine`
 * unchanged. This is only "which thread am I talking to" plus the confirmation
 * answer.
 */
export const assistantApi = {
  /** The conversation the overlay opens on; created server-side on first use. */
  thread: (signal?: AbortSignal) => api.get<Thread>("/assistant/thread", signal),
  threads: (signal?: AbortSignal) => api.get<Thread[]>("/assistant/threads", signal),
  newThread: () => api.post<Thread>("/assistant/threads", {}),
  /** Answer a destructive action's card. Unblocks the tool waiting on it. */
  confirm: (token: string, approved: boolean) =>
    api.post<void>(`/assistant/confirm/${token}`, { approved }),
}

export const assistantKeys = {
  all: ["assistant"] as const,
  thread: ["assistant", "thread"] as const,
  threads: ["assistant", "threads"] as const,
}

export function useAssistantThread(enabled = true) {
  return useQuery({
    queryKey: assistantKeys.thread,
    queryFn: ({ signal }) => assistantApi.thread(signal),
    // Only fetched once the overlay is actually opened: creating the thread is a
    // write, and every session shouldn't open one just by loading the app.
    enabled,
    staleTime: Infinity,
  })
}

export function useConfirmAction() {
  return useMutation({
    mutationFn: ({ token, approved }: { token: string; approved: boolean }) =>
      assistantApi.confirm(token, approved),
  })
}
