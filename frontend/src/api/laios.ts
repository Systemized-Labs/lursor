import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"

import { api } from "./client"
import type {
  LaiosBudget,
  LaiosClusterStatus,
  LaiosConnection,
  LaiosConnectionInput,
  LaiosConnectionStatus,
  LaiosInstance,
  LaiosInstanceLogs,
  LaiosInstanceStatus,
  LaiosJob,
  LaiosRecipeSummary,
  LaiosServeInput,
} from "./types"

// Statuses that are still moving toward a steady state — the UI polls faster
// and shows a spinner while any instance is in one of these.
const TRANSITIONAL: ReadonlySet<LaiosInstanceStatus> = new Set([
  "pending",
  "pulling",
  "starting",
  "stopping",
])

export function isTransitional(status: LaiosInstanceStatus): boolean {
  return TRANSITIONAL.has(status)
}

// All model-lifecycle calls are scoped to a connection id; the backend proxies
// them to that daemon's control plane holding the master_key server-side.
export const laiosApi = {
  listConnections: (signal?: AbortSignal) =>
    api.get<LaiosConnection[]>("/laios/connections", signal),
  createConnection: (input: LaiosConnectionInput) =>
    api.post<LaiosConnection>("/laios/connections", input),
  updateConnection: (id: string, input: Partial<LaiosConnectionInput>) =>
    api.patch<LaiosConnection>(`/laios/connections/${id}`, input),
  removeConnection: (id: string) =>
    api.delete<void>(`/laios/connections/${id}`),
  status: (id: string, signal?: AbortSignal) =>
    api.get<LaiosConnectionStatus>(`/laios/connections/${id}/status`, signal),
  instances: (id: string, signal?: AbortSignal) =>
    api.get<LaiosInstance[]>(`/laios/connections/${id}/instances`, signal),
  catalog: (id: string, signal?: AbortSignal) =>
    api.get<LaiosRecipeSummary[]>(`/laios/connections/${id}/catalog`, signal),
  budget: (id: string, signal?: AbortSignal) =>
    api.get<LaiosBudget>(`/laios/connections/${id}/budget`, signal),
  cluster: (id: string, signal?: AbortSignal) =>
    api.get<LaiosClusterStatus>(`/laios/connections/${id}/cluster`, signal),
  pull: (id: string, recipe: string) =>
    api.post<LaiosJob>(`/laios/connections/${id}/pull`, { recipe }),
  job: (id: string, jobId: string, signal?: AbortSignal) =>
    api.get<LaiosJob>(`/laios/connections/${id}/jobs/${jobId}`, signal),
  serve: (id: string, input: LaiosServeInput) =>
    api.post<LaiosInstance>(`/laios/connections/${id}/serve`, input),
  stop: (id: string, instanceId: string) =>
    api.post<LaiosInstance>(
      `/laios/connections/${id}/instances/${instanceId}/stop`,
      {}
    ),
  logs: (id: string, instanceId: string, tail = 200, signal?: AbortSignal) =>
    api.get<LaiosInstanceLogs>(
      `/laios/connections/${id}/instances/${instanceId}/logs?tail=${tail}`,
      signal
    ),
}

export const laiosKeys = {
  all: ["laios"] as const,
  connections: ["laios", "connections"] as const,
  status: (id: string) => ["laios", id, "status"] as const,
  instances: (id: string) => ["laios", id, "instances"] as const,
  catalog: (id: string) => ["laios", id, "catalog"] as const,
  budget: (id: string) => ["laios", id, "budget"] as const,
  cluster: (id: string) => ["laios", id, "cluster"] as const,
  logs: (id: string, instanceId: string) =>
    ["laios", id, "logs", instanceId] as const,
}

export function useLaiosConnections() {
  return useQuery({
    queryKey: laiosKeys.connections,
    queryFn: ({ signal }) => laiosApi.listConnections(signal),
  })
}

// Probe is explicit + polled: it reaches the user's daemon (possibly remote),
// so no focus refetch, and a failure is a status ("down"), not a retry loop.
export function useLaiosStatus(id: string | undefined) {
  return useQuery({
    queryKey: id ? laiosKeys.status(id) : laiosKeys.all,
    queryFn: ({ signal }) => laiosApi.status(id as string, signal),
    enabled: Boolean(id),
    staleTime: 10_000,
    refetchInterval: 15_000,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

export function useLaiosInstances(id: string | undefined) {
  return useQuery({
    queryKey: id ? laiosKeys.instances(id) : laiosKeys.all,
    queryFn: ({ signal }) => laiosApi.instances(id as string, signal),
    enabled: Boolean(id),
    // Adaptive polling: while a model is spinning up/down, poll fast so the UI
    // tracks the transition; once everything is steady, back off to save calls.
    refetchInterval: (query) => {
      const data = query.state.data
      return data?.some((i) => TRANSITIONAL.has(i.status)) ? 1_500 : 6_000
    },
    refetchOnWindowFocus: false,
    retry: false,
  })
}

export function useLaiosCatalog(id: string | undefined) {
  return useQuery({
    queryKey: id ? laiosKeys.catalog(id) : laiosKeys.all,
    queryFn: ({ signal }) => laiosApi.catalog(id as string, signal),
    enabled: Boolean(id),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

export function useLaiosBudget(id: string | undefined) {
  return useQuery({
    queryKey: id ? laiosKeys.budget(id) : laiosKeys.all,
    queryFn: ({ signal }) => laiosApi.budget(id as string, signal),
    enabled: Boolean(id),
    refetchInterval: 8_000,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

// Cluster resources: aggregate VRAM / node rollup across head + live workers.
// Polled on the same cadence as budget so the panel tracks membership changes.
export function useLaiosCluster(id: string | undefined) {
  return useQuery({
    queryKey: id ? laiosKeys.cluster(id) : laiosKeys.all,
    queryFn: ({ signal }) => laiosApi.cluster(id as string, signal),
    enabled: Boolean(id),
    refetchInterval: 8_000,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

// --- Connection mutations (invalidate the connections list) ---------------------

function useConnectionMutation<TArgs>(fn: (args: TArgs) => Promise<unknown>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: laiosKeys.connections })
    },
  })
}

export function useCreateLaiosConnection() {
  return useConnectionMutation((input: LaiosConnectionInput) =>
    laiosApi.createConnection(input)
  )
}

export function useUpdateLaiosConnection() {
  return useConnectionMutation(
    ({ id, input }: { id: string; input: Partial<LaiosConnectionInput> }) =>
      laiosApi.updateConnection(id, input)
  )
}

export function useDeleteLaiosConnection() {
  return useConnectionMutation((id: string) => laiosApi.removeConnection(id))
}

// --- Lifecycle mutations (optimistic, then reconcile via polling) ---------------

function upsertInstance(list: LaiosInstance[] | undefined, inst: LaiosInstance) {
  const next = list ? [...list] : []
  const i = next.findIndex((x) => x.id === inst.id)
  if (i >= 0) next[i] = inst
  else next.push(inst)
  return next
}

// Serve returns the (usually `starting`) instance immediately; the daemon
// promotes it in the background. We drop it into the cache right away so the
// card shows up instantly, then the adaptive poll tracks it to `running`.
export function useServeModel(connectionId: string) {
  const qc = useQueryClient()
  const key = laiosKeys.instances(connectionId)
  return useMutation({
    mutationFn: (input: LaiosServeInput) => laiosApi.serve(connectionId, input),
    onSuccess: (inst) => {
      qc.setQueryData<LaiosInstance[]>(key, (old) => upsertInstance(old, inst))
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: key })
      qc.invalidateQueries({ queryKey: laiosKeys.budget(connectionId) })
    },
  })
}

// Optimistically flip the card to `stopping` so the UI responds instantly,
// rolling back if the request fails.
export function useStopInstance(connectionId: string) {
  const qc = useQueryClient()
  const key = laiosKeys.instances(connectionId)
  return useMutation({
    mutationFn: (instanceId: string) => laiosApi.stop(connectionId, instanceId),
    onMutate: async (instanceId) => {
      await qc.cancelQueries({ queryKey: key })
      const previous = qc.getQueryData<LaiosInstance[]>(key)
      qc.setQueryData<LaiosInstance[]>(key, (old) =>
        old?.map((i) =>
          i.id === instanceId ? { ...i, status: "stopping" } : i
        )
      )
      return { previous }
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.previous) qc.setQueryData(key, ctx.previous)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: key })
      qc.invalidateQueries({ queryKey: laiosKeys.budget(connectionId) })
    },
  })
}

// --- Serve manager: track in-flight spin-ups as visible cards ------------------
//
// A model has no daemon instance record until *after* it's downloaded and
// serve is called, so downloading models would otherwise be invisible. We track
// each in-flight serve as a synthetic entry (download → start) and render it in
// the models grid, then hand off to the real (polled) instance once it exists.

export interface PendingServe {
  key: string
  connectionId: string
  recipeId: string
  name: string
  phase: "pulling" | "starting" | "failed"
  error?: string
}

export function useServeManager(connectionId: string | undefined) {
  const [pending, setPending] = useState<PendingServe[]>([])
  const serveModel = useServeModel(connectionId ?? "")

  // Forget entries not belonging to the active connection (e.g. after a switch).
  useEffect(() => {
    setPending((p) => p.filter((x) => x.connectionId === connectionId))
  }, [connectionId])

  const start = useCallback(
    async (input: LaiosServeInput, name: string) => {
      if (!connectionId) return
      const key =
        globalThis.crypto?.randomUUID?.() ?? `${input.recipe}-${Math.random()}`
      const entry: PendingServe = {
        key,
        connectionId,
        recipeId: input.recipe,
        name,
        phase: "pulling",
      }
      setPending((p) => [...p, entry])
      try {
        // 1) Download (idempotent; fast when already cached).
        const job = await laiosApi.pull(connectionId, input.recipe)
        for (;;) {
          const j = await laiosApi.job(connectionId, job.id)
          if (j.status === "succeeded") break
          if (j.status === "failed") throw new Error(j.error || "Download failed")
          await new Promise((r) => setTimeout(r, 2000))
        }
        // 2) Start the engine — the real instance takes over the card.
        setPending((p) =>
          p.map((x) => (x.key === key ? { ...x, phase: "starting" } : x))
        )
        const inst = await serveModel.mutateAsync(input)
        setPending((p) => p.filter((x) => x.key !== key))
        toast.success(`Serving ${inst.served_name}`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to serve model"
        setPending((p) =>
          p.map((x) => (x.key === key ? { ...x, phase: "failed", error: msg } : x))
        )
        toast.error(msg)
      }
    },
    [connectionId, serveModel]
  )

  const dismiss = useCallback((key: string) => {
    setPending((p) => p.filter((x) => x.key !== key))
  }, [])

  return {
    pending: pending.filter((x) => x.connectionId === connectionId),
    start,
    dismiss,
  }
}
