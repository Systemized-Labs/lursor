import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query"

import { api } from "./client"
import type { Thread, ThreadInput, ThreadMessage, ThreadUpdate } from "./types"

export const threadsApi = {
  listByWorkspace: (workspaceId: string, signal?: AbortSignal) =>
    api.get<Thread[]>(
      `/threads?workspace_id=${encodeURIComponent(workspaceId)}`,
      signal
    ),
  /** Every conversation in every workspace, newest activity first. One request
   *  for the cross-workspace surfaces (the sidebar's Attention/Activity panels,
   *  the command palette) that would otherwise fan out per workspace. */
  listAll: (signal?: AbortSignal) => api.get<Thread[]>("/threads", signal),
  /** Conversations one schedule's fires opened, newest activity first. These are
   *  excluded from `listByWorkspace` so a daily job doesn't bury a workspace's
   *  human-started threads. */
  listBySchedule: (scheduleId: string, signal?: AbortSignal) =>
    api.get<Thread[]>(
      `/threads?schedule_id=${encodeURIComponent(scheduleId)}`,
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
  // Steer a running goal: buffer a user message for the loop's next turn.
  interjectGoal: (id: string, content: string) =>
    api.post<{ queued: boolean }>(`/threads/${id}/goal/interject`, { content }),
  // Condense the conversation into a single carry-forward summary (/compact).
  // `compacted` is false when there wasn't enough history to condense. How much
  // is folded in is the agent's `compaction_ratio`, so the counts report what the
  // summary covers (`summarized`) and what was left verbatim behind it (`kept`).
  compact: (id: string) =>
    api.post<{
      compacted: boolean
      reason?: string
      summarized?: number
      kept?: number
    }>(`/threads/${id}/compact`, {}),
}

export const threadKeys = {
  /** The cross-workspace list. A *separate* cache entry from the per-workspace
   *  lists, so anything that mutates conversations has to invalidate both — see
   *  {@link invalidateThreadLists}. Deliberately not named `all`: by react-query
   *  convention that reads as "every query in this domain", and someone
   *  invalidating it expecting that would quietly miss the per-workspace ones. */
  crossWorkspace: () => ["threads", "all"] as const,
  /** Prefix covering every per-workspace list at once. */
  byWorkspacePrefix: () => ["threads", "workspace"] as const,
  byWorkspace: (workspaceId: string) =>
    ["threads", "workspace", workspaceId] as const,
  bySchedule: (scheduleId: string) =>
    ["threads", "schedule", scheduleId] as const,
  detail: (id: string) => ["threads", id] as const,
  messages: (id: string) => ["threads", id, "messages"] as const,
  activeRuns: () => ["threads", "active-runs"] as const,
}

/**
 * Refresh the conversation lists after a mutation. There are two shapes — the
 * cross-workspace list behind {@link threadKeys.crossWorkspace} and the
 * per-workspace lists behind {@link threadKeys.byWorkspace} — and forgetting
 * the former leaves the sidebar's Attention and Activity sections showing
 * conversations the workspace sections have already dropped. Always go through
 * here.
 *
 * Omit `workspaceId` to sweep every per-workspace list (e.g. when a background
 * run finishes and we don't know which lists reordered).
 */
export function invalidateThreadLists(
  qc: QueryClient,
  workspaceId?: string
): void {
  qc.invalidateQueries({ queryKey: threadKeys.crossWorkspace() })
  qc.invalidateQueries({
    queryKey: workspaceId
      ? threadKeys.byWorkspace(workspaceId)
      : threadKeys.byWorkspacePrefix(),
  })
}

/** Every conversation across every workspace, newest activity first. */
export function useAllThreadsQuery() {
  return useQuery({
    queryKey: threadKeys.crossWorkspace(),
    queryFn: ({ signal }) => threadsApi.listAll(signal),
  })
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
    onSuccess: (thread) => invalidateThreadLists(qc, thread.workspace_id),
  })
}

export function useUpdateThread() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: ThreadUpdate }) =>
      threadsApi.update(id, input),
    onSuccess: (thread) => {
      invalidateThreadLists(qc, thread.workspace_id)
      qc.invalidateQueries({ queryKey: threadKeys.detail(thread.id) })
    },
  })
}

export function useDeleteThread(workspaceId: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => threadsApi.remove(id),
    onSuccess: () => invalidateThreadLists(qc, workspaceId),
  })
}
