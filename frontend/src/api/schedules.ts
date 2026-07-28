import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { api } from "./client"
import { threadKeys } from "./threads"
import type {
  CronPreview,
  Schedule,
  ScheduleInput,
  ScheduleRun,
  ScheduleUpdateInput,
} from "./types"

export const schedulesApi = {
  list: (workspaceId?: string | null, signal?: AbortSignal) =>
    api.get<Schedule[]>(
      workspaceId
        ? `/schedules?workspace_id=${encodeURIComponent(workspaceId)}`
        : "/schedules",
      signal
    ),
  get: (id: string, signal?: AbortSignal) =>
    api.get<Schedule>(`/schedules/${id}`, signal),
  create: (input: ScheduleInput) => api.post<Schedule>("/schedules", input),
  update: (id: string, input: ScheduleUpdateInput) =>
    api.patch<Schedule>(`/schedules/${id}`, input),
  remove: (id: string) => api.delete<void>(`/schedules/${id}`),
  /** Fire now without consuming the scheduled slot. Resolves with the run row,
   *  whose `thread_id` is the conversation to navigate into. */
  runNow: (id: string) => api.post<ScheduleRun>(`/schedules/${id}/run-now`, {}),
  runs: (id: string, signal?: AbortSignal) =>
    api.get<ScheduleRun[]>(`/schedules/${id}/runs`, signal),
  /** Next N fires for a candidate expression — what makes a cron string
   *  trustworthy before it costs money. */
  preview: (cron: string, timezone: string, count = 5) =>
    api.post<CronPreview>("/schedules/preview", { cron, timezone, count }),
}

export const scheduleKeys = {
  all: ["schedules"] as const,
  list: (workspaceId?: string | null) =>
    ["schedules", "list", workspaceId ?? null] as const,
  detail: (id: string) => ["schedules", id] as const,
  runs: (id: string) => ["schedules", id, "runs"] as const,
  preview: (cron: string, timezone: string) =>
    ["schedules", "preview", cron, timezone] as const,
}

export function useSchedules(workspaceId?: string | null) {
  return useQuery({
    queryKey: scheduleKeys.list(workspaceId),
    queryFn: ({ signal }) => schedulesApi.list(workspaceId, signal),
    // `next_fire_at` and the last outcome are both clocks: without this the rail
    // would keep saying "in 2m" long after the run started.
    refetchInterval: 30_000,
  })
}

export function useSchedule(id: string | undefined) {
  return useQuery({
    queryKey: scheduleKeys.detail(id ?? ""),
    queryFn: ({ signal }) => schedulesApi.get(id as string, signal),
    enabled: Boolean(id),
  })
}

export function useScheduleRuns(id: string | undefined) {
  return useQuery({
    queryKey: scheduleKeys.runs(id ?? ""),
    queryFn: ({ signal }) => schedulesApi.runs(id as string, signal),
    enabled: Boolean(id),
    refetchInterval: 30_000,
  })
}

/**
 * The next few fires for an expression the user is still typing.
 *
 * Only enabled once both fields are non-empty; a 422 for a half-typed expression
 * is expected, so failures are left to the caller to render as "not a valid
 * expression yet" rather than retried.
 */
export function useCronPreview(cron: string, timezone: string) {
  const trimmed = cron.trim()
  return useQuery({
    queryKey: scheduleKeys.preview(trimmed, timezone),
    queryFn: () => schedulesApi.preview(trimmed, timezone),
    enabled: Boolean(trimmed && timezone),
    retry: false,
    staleTime: 30_000,
  })
}

function useScheduleMutation<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => void qc.invalidateQueries({ queryKey: scheduleKeys.all }),
  })
}

export function useCreateSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: ScheduleInput) => schedulesApi.create(input),
    onSuccess: (created) => {
      // Seeded into the unfiltered list *before* the refetch: the caller selects
      // the new row as soon as this resolves, and the rail drops a selection it
      // can't find among its own rows (same reason as `useCreateEnvVar`).
      qc.setQueryData<Schedule[]>(scheduleKeys.list(), (prev) =>
        prev ? [...prev, created] : prev
      )
      void qc.invalidateQueries({ queryKey: scheduleKeys.all })
    },
  })
}

export function useUpdateSchedule() {
  return useScheduleMutation(
    ({ id, input }: { id: string; input: ScheduleUpdateInput }) =>
      schedulesApi.update(id, input)
  )
}

export function useDeleteSchedule() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => schedulesApi.remove(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: scheduleKeys.all })
      // Deleting a schedule hands its conversations back to their workspace as
      // ordinary ones, so the sidebar's lists change too.
      void qc.invalidateQueries({ queryKey: ["threads"] })
    },
  })
}

export function useRunScheduleNow() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => schedulesApi.runNow(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: scheduleKeys.all })
      // A launched fire is a live run; refresh the badge source immediately
      // rather than waiting out its poll.
      void qc.invalidateQueries({ queryKey: threadKeys.activeRuns() })
    },
  })
}
