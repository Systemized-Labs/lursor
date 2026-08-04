import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { useMemo } from "react"

import { API_BASE, api } from "./client"
import { useLaiosModels } from "./laios"
import type {
  LaiosVideoInput,
  LaiosVideoJob,
  LaiosVideoStatus,
  VideoCapability,
} from "./types"

// Statuses that will not change again. Everything else is worth polling.
const TERMINAL: ReadonlySet<LaiosVideoStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
])

export function isVideoActive(job: LaiosVideoJob): boolean {
  return !TERMINAL.has(job.status)
}

export const videosApi = {
  list: (cid: string, signal?: AbortSignal) =>
    api.get<LaiosVideoJob[]>(`/laios/connections/${cid}/videos`, signal),
  create: (cid: string, input: LaiosVideoInput) =>
    api.post<LaiosVideoJob>(`/laios/connections/${cid}/videos`, input),
  // Reaches the gateway and folds the result into our row, so this is what
  // actually advances a job's status — the list is read from our own table.
  status: (cid: string, jobId: string, signal?: AbortSignal) =>
    api.get<LaiosVideoJob>(`/laios/connections/${cid}/videos/${jobId}`, signal),
  cancel: (cid: string, jobId: string) =>
    api.delete<LaiosVideoJob>(`/laios/connections/${cid}/videos/${jobId}`),
  // Not connection-scoped: "can anything connected generate video".
  capability: (signal?: AbortSignal) =>
    api.get<VideoCapability>("/video/capability", signal),
}

/**
 * URL the `<video>` element loads directly.
 *
 * Not routed through the JSON client: the browser fetches this itself so it can
 * range-request and seek. The backend serves it from the media store once the
 * clip has been pulled down.
 */
export function videoContentUrl(cid: string, jobId: string): string {
  return `${API_BASE}/laios/connections/${cid}/videos/${jobId}/content`
}

export const videoKeys = {
  all: ["videos"] as const,
  capability: ["videos", "capability"] as const,
  jobs: (cid: string) => ["videos", cid, "jobs"] as const,
  job: (cid: string, jobId: string) => ["videos", cid, "job", jobId] as const,
}

/**
 * Whether any connected box can generate video, and which model would be used.
 *
 * Behind the same 5-minute resolver cache the agent build uses, so this is cheap;
 * `enabled` lets a caller skip it entirely until a dialog is open.
 */
export function useVideoCapability(enabled = true) {
  return useQuery({
    queryKey: videoKeys.capability,
    queryFn: ({ signal }) => videosApi.capability(signal),
    enabled,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

/**
 * Every job submitted to this connection.
 *
 * Cheap and side-effect free — it reads our table, not the gateway. Status is
 * advanced by :func:`useVideoJobSync`, which polls the active ones by id.
 */
export function useVideoJobs(cid: string | undefined) {
  return useQuery({
    queryKey: cid ? videoKeys.jobs(cid) : videoKeys.all,
    queryFn: ({ signal }) => videosApi.list(cid as string, signal),
    enabled: Boolean(cid),
    refetchOnWindowFocus: false,
    retry: false,
  })
}

/**
 * Polls each still-running job so the list advances.
 *
 * Per job rather than in bulk because that is the shape the gateway offers —
 * a job is polled by id, and laios deliberately does not proxy the engine's own
 * job list (across several backends it would have to be merged rather than
 * routed). A clip takes minutes at ~44 s per denoise step, so 5s is already far
 * finer-grained than the thing being measured.
 */
export function useVideoJobSync(
  cid: string | undefined,
  jobs: LaiosVideoJob[] | undefined
) {
  const qc = useQueryClient()
  const active = useMemo(
    () => (jobs ?? []).filter(isVideoActive).map((j) => j.job_id),
    [jobs]
  )

  useQueries({
    queries: active.map((jobId) => ({
      queryKey: videoKeys.job(cid as string, jobId),
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const fresh = await videosApi.status(cid as string, jobId, signal)
        // Fold straight into the list so the table re-renders without a second
        // round trip, and stop polling as soon as it lands.
        qc.setQueryData<LaiosVideoJob[]>(videoKeys.jobs(cid as string), (prev) =>
          prev?.map((j) => (j.job_id === jobId ? fresh : j))
        )
        return fresh
      },
      enabled: Boolean(cid),
      refetchInterval: 5_000,
      refetchOnWindowFocus: false,
      retry: false,
    })),
  })
}

export function useSubmitVideo(cid: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: LaiosVideoInput) =>
      videosApi.create(cid as string, input),
    onSuccess: () => {
      if (cid) qc.invalidateQueries({ queryKey: videoKeys.jobs(cid) })
    },
  })
}

export function useCancelVideo(cid: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (jobId: string) => videosApi.cancel(cid as string, jobId),
    onSuccess: () => {
      if (cid) qc.invalidateQueries({ queryKey: videoKeys.jobs(cid) })
    },
  })
}

/** A served model that generates video rather than tokens. */
export interface VideoModelOption {
  /** The name to put in the request's `model` field. */
  servedName: string
  /** Human label from the model inventory. */
  label: string
}

/**
 * Video-capable models currently serving on this connection.
 *
 * Derived from the control plane's model inventory, which already carries
 * `capabilities` per recipe and the live instance serving it. The gateway's own
 * `/v1/models` is a flat OpenAI list with no capability field, so it cannot tell
 * a generator from an LLM — this join is what keeps a video model out of a chat
 * picker and a chat model out of this page.
 *
 * `controlReachable` is false when the inventory could not be read at all — a
 * tunnelled box without `expose_control` set. The page falls back to a free-text
 * model field in that case rather than showing an empty picker.
 */
export function useVideoModels(cid: string | undefined) {
  const { data, isLoading, isError } = useLaiosModels(cid)

  const options = useMemo<VideoModelOption[]>(() => {
    if (!data) return []
    return data
      .filter(
        (m) =>
          m.capabilities.includes("video") &&
          m.running_instance?.status === "running"
      )
      .map((m) => ({
        servedName: m.running_instance?.served_name ?? m.served_model_name,
        label: m.name || m.id,
      }))
      .filter((o) => Boolean(o.servedName))
  }, [data])

  return {
    options,
    isLoading,
    controlReachable: !isError,
  }
}
