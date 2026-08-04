import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { useMemo } from "react"

import { API_BASE, api } from "./client"
import { useLaiosModels } from "./laios"
import type { LaiosImageInput, LaiosImageRun, LaiosImageStatus } from "./types"

// Statuses that will not change again. Everything else is worth polling.
const TERMINAL: ReadonlySet<LaiosImageStatus> = new Set(["completed", "failed"])

export function isImageActive(run: LaiosImageRun): boolean {
  return !TERMINAL.has(run.status)
}

export const imagesApi = {
  list: (cid: string, signal?: AbortSignal) =>
    api.get<LaiosImageRun[]>(`/laios/connections/${cid}/images`, signal),
  create: (cid: string, input: LaiosImageInput) =>
    api.post<LaiosImageRun>(`/laios/connections/${cid}/images`, input),
  // A row read — the backend's own task is what advances a generation, so unlike
  // the video equivalent this touches no network and costs nothing to poll.
  status: (cid: string, runId: string, signal?: AbortSignal) =>
    api.get<LaiosImageRun>(`/laios/connections/${cid}/images/${runId}`, signal),
  // Removes the run. Not a cancel: the engine has no cancel on this API, so a
  // generation already on the GPU keeps it — this stops the backend waiting for
  // it and drops the row.
  remove: (cid: string, runId: string) =>
    api.delete<{ deleted: string }>(
      `/laios/connections/${cid}/images/${runId}`
    ),
}

/**
 * URL the `<img>` element loads directly.
 *
 * Not routed through the JSON client — the browser fetches it itself. Already on
 * disk by the time a run is `completed`: the backend stores the image as part of
 * finishing, so this never blocks on the gateway.
 */
export function imageContentUrl(cid: string, runId: string): string {
  return `${API_BASE}/laios/connections/${cid}/images/${runId}/content`
}

export const imageKeys = {
  all: ["images"] as const,
  runs: (cid: string) => ["images", cid, "runs"] as const,
  run: (cid: string, runId: string) => ["images", cid, "run", runId] as const,
}

/** Every generation submitted to this connection. */
export function useImageRuns(cid: string | undefined) {
  return useQuery({
    queryKey: cid ? imageKeys.runs(cid) : imageKeys.all,
    queryFn: ({ signal }) => imagesApi.list(cid as string, signal),
    enabled: Boolean(cid),
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
  cid: string | undefined,
  runs: LaiosImageRun[] | undefined
) {
  const qc = useQueryClient()
  const active = useMemo(
    () => (runs ?? []).filter(isImageActive).map((r) => r.id),
    [runs]
  )

  useQueries({
    queries: active.map((runId) => ({
      queryKey: imageKeys.run(cid as string, runId),
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const fresh = await imagesApi.status(cid as string, runId, signal)
        // Fold straight into the list so the grid re-renders without a second
        // round trip, and stop polling as soon as it lands.
        qc.setQueryData<LaiosImageRun[]>(imageKeys.runs(cid as string), (prev) =>
          prev?.map((r) => (r.id === runId ? fresh : r))
        )
        return fresh
      },
      enabled: Boolean(cid),
      refetchInterval: 1_500,
      refetchOnWindowFocus: false,
      retry: false,
    })),
  })
}

export function useSubmitImage(cid: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: LaiosImageInput) =>
      imagesApi.create(cid as string, input),
    onSuccess: () => {
      if (cid) qc.invalidateQueries({ queryKey: imageKeys.runs(cid) })
    },
  })
}

export function useDeleteImage(cid: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (runId: string) => imagesApi.remove(cid as string, runId),
    onSuccess: () => {
      if (cid) qc.invalidateQueries({ queryKey: imageKeys.runs(cid) })
    },
  })
}

/** A served model that generates images rather than tokens. */
export interface ImageModelOption {
  /** The name to put in the request's `model` field. */
  servedName: string
  /** Human label from the model inventory. */
  label: string
}

/**
 * Image-capable models currently serving on this connection.
 *
 * The same join the video page relies on, against `capabilities: [image]`: the
 * gateway's own `/v1/models` is a flat OpenAI list with no capability field, so it
 * cannot tell a diffusion model from an LLM. Reading the control plane's
 * inventory is what keeps an image model out of a chat picker and a chat model out
 * of this page.
 *
 * `controlReachable` is false when the inventory could not be read at all — a
 * tunnelled box without `expose_control` set. The page falls back to a free-text
 * model field in that case rather than showing an empty picker.
 */
export function useImageModels(cid: string | undefined) {
  const { data, isLoading, isError } = useLaiosModels(cid)

  const options = useMemo<ImageModelOption[]>(() => {
    if (!data) return []
    return data
      .filter(
        (m) =>
          m.capabilities.includes("image") &&
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
