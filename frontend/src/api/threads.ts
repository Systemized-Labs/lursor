import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"

import { api } from "./client"
import type { Thread, ThreadInput, ThreadMessage, ThreadUpdate } from "./types"

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
  update: (id: string, input: ThreadUpdate) =>
    api.patch<Thread>(`/threads/${id}`, input),
  remove: (id: string) => api.delete<void>(`/threads/${id}`),
  // Thread ids with a live background chat run (drives the running badges).
  activeRuns: (signal?: AbortSignal) =>
    api.get<string[]>("/threads/active-runs", signal),
  // Cancel the in-flight run for a thread (204/404 when nothing is running).
  stop: (id: string) => api.post<{ stopped: boolean }>(`/threads/${id}/stop`, {}),
  // Release a goal run parked at the plan-approval checkpoint.
  approveGoal: (id: string) =>
    api.post<{ approved: boolean }>(`/threads/${id}/goal/approve`, {}),
  // Steer a running goal: buffer a user message for the loop's next turn.
  interjectGoal: (id: string, content: string) =>
    api.post<{ queued: boolean }>(`/threads/${id}/goal/interject`, { content }),
}

export const threadKeys = {
  byWorkspace: (workspaceId: string) =>
    ["threads", "workspace", workspaceId] as const,
  detail: (id: string) => ["threads", id] as const,
  messages: (id: string) => ["threads", id, "messages"] as const,
  activeRuns: () => ["threads", "active-runs"] as const,
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

/**
 * Polls the set of threads with a live background run. Used both for the
 * sidebar "running" badges and to decide whether to reconnect on open.
 */
export function useActiveRuns() {
  return useQuery({
    queryKey: threadKeys.activeRuns(),
    queryFn: ({ signal }) => threadsApi.activeRuns(signal),
    refetchInterval: 3000,
    placeholderData: keepPreviousData,
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

export function useUpdateThread() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ThreadUpdate }) =>
      threadsApi.update(id, input),
    onSuccess: (thread) => {
      qc.invalidateQueries({
        queryKey: threadKeys.byWorkspace(thread.workspace_id),
      })
      qc.invalidateQueries({ queryKey: threadKeys.detail(thread.id) })
    },
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
