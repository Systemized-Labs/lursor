import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"

import { api } from "./client"
import type { Thread, ThreadInput, ThreadMessage } from "./types"

export const threadsApi = {
  listByWorkspace: (workspaceId: string, signal?: AbortSignal) =>
    api.get<Thread[]>(
      `/threads?workspace_id=${encodeURIComponent(workspaceId)}`,
      signal
    ),
  get: (id: string, signal?: AbortSignal) =>
    api.get<Thread>(`/threads/${id}`, signal),
  messages: (id: string, signal?: AbortSignal) =>
    api.get<ThreadMessage[]>(`/threads/${id}/messages`, signal),
  create: (input: ThreadInput) => api.post<Thread>("/threads", input),
  remove: (id: string) => api.delete<void>(`/threads/${id}`),
}

export const threadKeys = {
  byWorkspace: (workspaceId: string) =>
    ["threads", "workspace", workspaceId] as const,
  detail: (id: string) => ["threads", id] as const,
  messages: (id: string) => ["threads", id, "messages"] as const,
}

export function useThreads(workspaceId: string | undefined) {
  return useQuery({
    queryKey: threadKeys.byWorkspace(workspaceId ?? ""),
    queryFn: ({ signal }) =>
      threadsApi.listByWorkspace(workspaceId as string, signal),
    enabled: Boolean(workspaceId),
  })
}

export function useThread(id: string | undefined) {
  return useQuery({
    queryKey: threadKeys.detail(id ?? ""),
    queryFn: ({ signal }) => threadsApi.get(id as string, signal),
    enabled: Boolean(id),
  })
}

export function useThreadMessages(id: string | undefined) {
  return useQuery({
    queryKey: threadKeys.messages(id ?? ""),
    queryFn: ({ signal }) => threadsApi.messages(id as string, signal),
    enabled: Boolean(id),
  })
}

export function useCreateThread() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: ThreadInput) => threadsApi.create(input),
    onSuccess: (thread) =>
      qc.invalidateQueries({
        queryKey: threadKeys.byWorkspace(thread.workspace_id),
      }),
  })
}

export function useDeleteThread(workspaceId: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => threadsApi.remove(id),
    onSuccess: () => {
      if (workspaceId) {
        qc.invalidateQueries({
          queryKey: threadKeys.byWorkspace(workspaceId),
        })
      }
    },
  })
}
