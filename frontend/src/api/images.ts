import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { useMemo } from "react"

import { API_BASE, api } from "./client"
import type {
  ImageCapability,
  LaiosImageInput,
  LaiosImageRun,
  LaiosImageStatus,
  MediaModelList,
  MediaModelOption,
} from "./types"

// Statuses that will not change again. Everything else is worth polling.
const TERMINAL: ReadonlySet<LaiosImageStatus> = new Set(["completed", "failed"])

export function isImageActive(run: LaiosImageRun): boolean {
  return !TERMINAL.has(run.status)
}

/**
 * Everything here is keyed by a **source ref**, not a laios connection id.
 *
 * An OpenRouter generation has no connection to be keyed on, and run ids were
 * already uuids — so `(connection, run)` collapsed to `run`, and a content URL
 * needs no source at all. `source` is optional on the reads: omitting it returns
 * every source's history, which is what the gallery and the artifacts pane want.
 */
export const imagesApi = {
  list: (source?: string, signal?: AbortSignal) =>
    api.get<LaiosImageRun[]>(
      source ? `/media/images?source=${encodeURIComponent(source)}` : "/media/images",
      signal
    ),
  create: (input: LaiosImageInput) =>
    api.post<LaiosImageRun>("/media/images", input),
  // A row read — the backend's own task is what advances a generation, on either
  // source, so unlike the video equivalent this touches no network.
  status: (runId: string, signal?: AbortSignal) =>
    api.get<LaiosImageRun>(`/media/images/${runId}`, signal),
  // Removes the run. Not a cancel: neither source offers one on its image API, so
  // a generation already running keeps going — this stops the backend waiting for
  // it and drops the row.
  remove: (runId: string) =>
    api.delete<{ deleted: string }>(`/media/images/${runId}`),
  models: (source?: string, signal?: AbortSignal) =>
    api.get<MediaModelList<MediaModelOption>>(
      source
        ? `/media/images/models?source=${encodeURIComponent(source)}`
        : "/media/images/models",
      signal
    ),
  // Not source-scoped: "can this app generate images at all, and with what".
  capability: (signal?: AbortSignal) =>
    api.get<ImageCapability>("/image/capability", signal),
}

/**
 * URL the `<img>` element loads directly.
 *
 * Not routed through the JSON client — the browser fetches it itself. Already on
 * disk by the time a run is `completed`: the backend stores the image as part of
 * finishing, whichever source produced it, so this never blocks on an upstream.
 */
export function imageContentUrl(runId: string): string {
  return `${API_BASE}/media/images/${runId}/content`
}

export const imageKeys = {
  all: ["images"] as const,
  capability: ["images", "capability"] as const,
  models: (source?: string) => ["images", "models", source ?? ""] as const,
  runs: (source?: string) => ["images", "runs", source ?? ""] as const,
  run: (runId: string) => ["images", "run", runId] as const,
}

/**
 * Whether the configured source can generate images, and which model would run.
 *
 * Behind the same resolver cache the agent build uses, so this is cheap;
 * `enabled` lets a caller skip it entirely until a dialog is open.
 */
export function useImageCapability(enabled = true) {
  return useQuery({
    queryKey: imageKeys.capability,
    queryFn: ({ signal }) => imagesApi.capability(signal),
    enabled,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

/**
 * Generations, optionally narrowed to one source.
 *
 * Passing nothing returns all of them on purpose. Switching the source in
 * Settings must not empty the gallery — the images are still on disk, and a
 * history that vanished on a settings change would read as data loss.
 */
export function useImageRuns(source?: string) {
  return useQuery({
    queryKey: imageKeys.runs(source),
    queryFn: ({ signal }) => imagesApi.list(source, signal),
    refetchOnWindowFocus: false,
    retry: false,
  })
}

/**
 * Polls each still-running generation so the list advances.
 *
 * Faster than the video page's 5s because the thing being measured is far
 * shorter: `z-image-turbo` finishes in ~6.5s, so a 5s poll would show one frame
 * of progress before the image simply appeared. At 1.5s a fast generation still
 * looks like it happened, and the poll is a local row read either way.
 */
export function useImageRunSync(
  source: string | undefined,
  runs: LaiosImageRun[] | undefined
) {
  const qc = useQueryClient()
  const active = useMemo(
    () => (runs ?? []).filter(isImageActive).map((r) => r.id),
    [runs]
  )

  useQueries({
    queries: active.map((runId) => ({
      queryKey: imageKeys.run(runId),
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const fresh = await imagesApi.status(runId, signal)
        // Fold straight into the list so the grid re-renders without a second
        // round trip, and stop polling as soon as it lands.
        qc.setQueryData<LaiosImageRun[]>(imageKeys.runs(source), (prev) =>
          prev?.map((r) => (r.id === runId ? fresh : r))
        )
        return fresh
      },
      refetchInterval: 1_500,
      refetchOnWindowFocus: false,
      retry: false,
    })),
  })
}

export function useSubmitImage(source?: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: LaiosImageInput) =>
      imagesApi.create(source ? { source, ...input } : input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: imageKeys.all })
    },
  })
}

export function useDeleteImage() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (runId: string) => imagesApi.remove(runId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: imageKeys.all })
    },
  })
}

/**
 * The image models one source offers, priced where a price is known.
 *
 * The capability join that used to happen here — filtering the laios inventory on
 * `capabilities: [image]` and a running instance — now happens server-side, which
 * is also what lets one hook serve both sources. `reason` says why the list is
 * empty when it is, and it is never "unavailable" without one: the source does
 * not fall back, so an empty picker has to explain itself or it reads as a bug.
 */
export function useImageModels(source?: string) {
  const query = useQuery({
    queryKey: imageKeys.models(source),
    queryFn: ({ signal }) => imagesApi.models(source, signal),
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
