import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { useMemo } from "react"

import { API_BASE, api } from "./client"
import type {
  LaiosVideoInput,
  LaiosVideoJob,
  LaiosVideoStatus,
  MediaModelList,
  MediaVideoModelOption,
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

/**
 * Keyed by a **source ref** rather than a laios connection id — see
 * `api/images.ts` for the argument. Job ids stay the routing key here, because
 * both upstreams mint a unique one and the agent tools speak in them.
 */
export const videosApi = {
  list: (source?: string, signal?: AbortSignal) =>
    api.get<LaiosVideoJob[]>(
      source ? `/media/videos?source=${encodeURIComponent(source)}` : "/media/videos",
      signal
    ),
  create: (input: LaiosVideoInput) =>
    api.post<LaiosVideoJob>("/media/videos", input),
  // Reaches the upstream and folds the result into our row, so this is what
  // actually advances a job's status — the list is read from our own table. On
  // the OpenRouter path it is also what pulls the finished clip down, because the
  // download URL expires.
  status: (jobId: string, signal?: AbortSignal) =>
    api.get<LaiosVideoJob>(`/media/videos/${jobId}`, signal),
  // A real cancel on a box; on OpenRouter it only stops us tracking the job — the
  // render continues and is billed either way, and the row says so.
  cancel: (jobId: string) => api.delete<LaiosVideoJob>(`/media/videos/${jobId}`),
  models: (source?: string, signal?: AbortSignal) =>
    api.get<MediaModelList<MediaVideoModelOption>>(
      source
        ? `/media/videos/models?source=${encodeURIComponent(source)}`
        : "/media/videos/models",
      signal
    ),
  // Not source-scoped: "can this app generate video at all, and with what".
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
export function videoContentUrl(jobId: string): string {
  return `${API_BASE}/media/videos/${jobId}/content`
}

export const videoKeys = {
  all: ["videos"] as const,
  capability: ["videos", "capability"] as const,
  models: (source?: string) => ["videos", "models", source ?? ""] as const,
  jobs: (source?: string) => ["videos", "jobs", source ?? ""] as const,
  job: (jobId: string) => ["videos", "job", jobId] as const,
}

/**
 * Whether the configured source can generate video, and which model would run.
 *
 * Behind the same resolver cache the agent build uses, so this is cheap;
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
 * Jobs, optionally narrowed to one source.
 *
 * Cheap and side-effect free — it reads our table, not an upstream. Status is
 * advanced by {@link useVideoJobSync}, which polls the active ones by id.
 */
export function useVideoJobs(source?: string) {
  return useQuery({
    queryKey: videoKeys.jobs(source),
    queryFn: ({ signal }) => videosApi.list(source, signal),
    refetchOnWindowFocus: false,
    retry: false,
  })
}

/**
 * Polls each still-running job so the list advances.
 *
 * Per job rather than in bulk because that is the shape both upstreams offer —
 * a job is polled by id, and laios deliberately does not proxy the engine's own
 * job list (across several backends it would have to be merged rather than
 * routed). A clip takes minutes, so 5s is already far finer-grained than the
 * thing being measured.
 */
export function useVideoJobSync(
  source: string | undefined,
  jobs: LaiosVideoJob[] | undefined
) {
  const qc = useQueryClient()
  const active = useMemo(
    () => (jobs ?? []).filter(isVideoActive).map((j) => j.job_id),
    [jobs]
  )

  useQueries({
    queries: active.map((jobId) => ({
      queryKey: videoKeys.job(jobId),
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const fresh = await videosApi.status(jobId, signal)
        // Fold straight into the list so the table re-renders without a second
        // round trip, and stop polling as soon as it lands.
        qc.setQueryData<LaiosVideoJob[]>(videoKeys.jobs(source), (prev) =>
          prev?.map((j) => (j.job_id === jobId ? fresh : j))
        )
        return fresh
      },
      refetchInterval: 5_000,
      refetchOnWindowFocus: false,
      retry: false,
    })),
  })
}

export function useSubmitVideo(source?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: LaiosVideoInput) =>
      videosApi.create(source ? { source, ...input } : input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: videoKeys.all })
    },
  })
}

export function useCancelVideo() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (jobId: string) => videosApi.cancel(jobId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: videoKeys.all })
    },
  })
}

/**
 * The video models one source offers, with the clip shapes each will produce.
 *
 * The capability join that used to happen here — filtering the laios inventory on
 * `capabilities: [video]` and a running instance — now happens server-side,
 * alongside the "can this build drive its request shape" check that has always
 * been server-side. `reason` says why the list is empty when it is.
 */
export function useVideoModels(source?: string) {
  const query = useQuery({
    queryKey: videoKeys.models(source),
    queryFn: ({ signal }) => videosApi.models(source, signal),
    refetchOnWindowFocus: false,
    retry: false,
  })

  return {
    options: query.data?.models ?? [],
    available: query.data?.available ?? false,
    reason: query.data?.reason ?? "",
    isLoading: query.isLoading,
  }
}
