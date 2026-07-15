import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import { api } from "./client"
import type {
  LaiosBudget,
  LaiosClusterStatus,
  LaiosConnection,
  LaiosConnectionInput,
  LaiosConnectionStatus,
  LaiosDaemonRestart,
  LaiosDaemonUpdateLog,
  LaiosDaemonUpdateStarted,
  LaiosDaemonVersion,
  LaiosInstance,
  LaiosInstanceLogs,
  LaiosInstanceStatus,
  LaiosJob,
  LaiosJobStatus,
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
  jobs: (id: string, signal?: AbortSignal) =>
    api.get<LaiosJob[]>(`/laios/connections/${id}/jobs`, signal),
  job: (id: string, jobId: string, signal?: AbortSignal) =>
    api.get<LaiosJob>(`/laios/connections/${id}/jobs/${jobId}`, signal),
  serve: (id: string, input: LaiosServeInput) =>
    api.post<LaiosInstance>(`/laios/connections/${id}/serve`, input),
  stop: (id: string, instanceId: string) =>
    api.post<LaiosInstance>(
      `/laios/connections/${id}/instances/${instanceId}/stop`,
      {}
    ),
  remove: (id: string, instanceId: string) =>
    api.delete<LaiosInstance>(
      `/laios/connections/${id}/instances/${instanceId}`
    ),
  logs: (id: string, instanceId: string, tail = 200, signal?: AbortSignal) =>
    api.get<LaiosInstanceLogs>(
      `/laios/connections/${id}/instances/${instanceId}/logs?tail=${tail}`,
      signal
    ),
  // Daemon lifecycle. version is cheap; pass check=true to also `git fetch` and
  // report how far behind the checkout is (kept out of the default poll).
  daemonVersion: (id: string, check = false, signal?: AbortSignal) =>
    api.get<LaiosDaemonVersion>(
      `/laios/connections/${id}/daemon/version${check ? "?check=true" : ""}`,
      signal
    ),
  daemonRestart: (id: string) =>
    api.post<LaiosDaemonRestart>(`/laios/connections/${id}/daemon/restart`, {}),
  daemonUpdate: (id: string) =>
    api.post<LaiosDaemonUpdateStarted>(
      `/laios/connections/${id}/daemon/update`,
      {}
    ),
  daemonUpdateLog: (id: string, log: string, tail = 400, signal?: AbortSignal) =>
    api.get<LaiosDaemonUpdateLog>(
      `/laios/connections/${id}/daemon/update/log?log=${encodeURIComponent(
        log
      )}&tail=${tail}`,
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
  jobs: (id: string) => ["laios", id, "jobs"] as const,
  logs: (id: string, instanceId: string) =>
    ["laios", id, "logs", instanceId] as const,
  daemonVersion: (id: string) => ["laios", id, "daemon", "version"] as const,
  daemonUpdateCheck: (id: string) =>
    ["laios", id, "daemon", "update-check"] as const,
  daemonUpdateLog: (id: string, log: string) =>
    ["laios", id, "daemon", "update-log", log] as const,
}

// A pull job the daemon is still working on. Terminal jobs (succeeded/failed)
// are only interesting to a serve we initiated, handled in the serve manager.
const JOB_ACTIVE: ReadonlySet<LaiosJobStatus> = new Set(["queued", "running"])

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

// Background jobs (model pulls) with live byte progress. The daemon owns the
// download, so polling this keeps the UI truthful across reloads and shows
// pulls kicked off elsewhere. Poll fast while anything is in flight, then back
// off — matching the instances hook's adaptive cadence.
export function useLaiosJobs(id: string | undefined) {
  return useQuery({
    queryKey: id ? laiosKeys.jobs(id) : laiosKeys.all,
    queryFn: ({ signal }) => laiosApi.jobs(id as string, signal),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const data = query.state.data
      return data?.some((j) => JOB_ACTIVE.has(j.status)) ? 1_500 : 8_000
    },
    refetchOnWindowFocus: false,
    retry: false,
  })
}

// --- Daemon lifecycle -----------------------------------------------------------

// The running build (version + git sha + management mode). Polled so it tracks
// a restart/update: the sha advancing is how the UI confirms an update landed.
// This does NOT fetch from git (cheap); update-availability is a separate,
// on-demand check below.
export function useLaiosDaemonVersion(id: string | undefined) {
  return useQuery({
    queryKey: id ? laiosKeys.daemonVersion(id) : laiosKeys.all,
    queryFn: ({ signal }) => laiosApi.daemonVersion(id as string, false, signal),
    enabled: Boolean(id),
    staleTime: 15_000,
    refetchInterval: 20_000,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

// On-demand "is there an update?" — does a git fetch on the daemon, so it is
// disabled by default and run via refetch() when the user asks.
export function useLaiosUpdateCheck(id: string | undefined) {
  return useQuery({
    queryKey: id ? laiosKeys.daemonUpdateCheck(id) : laiosKeys.all,
    queryFn: ({ signal }) => laiosApi.daemonVersion(id as string, true, signal),
    enabled: false,
    retry: false,
    gcTime: 60_000,
  })
}

export function useDaemonRestart(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => laiosApi.daemonRestart(id),
    onSettled: () => {
      // The daemon is going down and coming back; nudge the version + status
      // polls so the UI reflects the reconnect quickly.
      qc.invalidateQueries({ queryKey: laiosKeys.daemonVersion(id) })
      qc.invalidateQueries({ queryKey: laiosKeys.status(id) })
    },
  })
}

export function useDaemonUpdate(id: string) {
  return useMutation({ mutationFn: () => laiosApi.daemonUpdate(id) })
}

// Track a daemon through a restart from wherever this hook is mounted (a page,
// not the dialog that triggered it) so the indicator outlives that dialog.
// Polls /status until the daemon is healthy again — clearing the instant a
// daemon we saw go down returns, or after a short settle window for a restart
// too fast to observe a drop. `start(id)` begins tracking that connection.
export function useDaemonReconnect() {
  const qc = useQueryClient()
  const [reconnectingId, setReconnectingId] = useState<string | undefined>()

  useEffect(() => {
    const id = reconnectingId
    if (!id) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const startedAt = Date.now()
    const POLL_MS = 800
    const DEADLINE_MS = 90_000
    const MIN_SETTLE_MS = 3_000
    let sawDown = false

    const finish = (ok: boolean) => {
      if (cancelled) return
      cancelled = true
      clearTimeout(timer)
      setReconnectingId(undefined)
      qc.invalidateQueries({ queryKey: laiosKeys.daemonVersion(id) })
      qc.invalidateQueries({ queryKey: laiosKeys.status(id) })
      if (ok) toast.success("Daemon back online")
      else
        toast.error(
          "Daemon hasn't come back yet — check its logs (it may still be starting)."
        )
    }

    const tick = async () => {
      if (cancelled) return
      let healthy = false
      try {
        const s = await laiosApi.status(id)
        healthy = s.status === "ok" && s.reachable
      } catch {
        healthy = false
      }
      if (cancelled) return
      if (!healthy) {
        sawDown = true
      } else if (sawDown || Date.now() - startedAt > MIN_SETTLE_MS) {
        finish(true)
        return
      }
      if (Date.now() - startedAt > DEADLINE_MS) {
        finish(false)
        return
      }
      timer = setTimeout(tick, POLL_MS)
    }

    timer = setTimeout(tick, POLL_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [reconnectingId, qc])

  const start = useCallback((id: string) => setReconnectingId(id), [])
  return { reconnectingId, start }
}

// Tail an in-progress update log. Polls while the daemon reports it active
// (recently written), then stops — the daemon restarts mid-update, so the log
// (on disk) is the durable source of truth across the gap.
export function useLaiosUpdateLog(
  id: string | undefined,
  log: string | undefined
) {
  return useQuery({
    queryKey:
      id && log ? laiosKeys.daemonUpdateLog(id, log) : laiosKeys.all,
    queryFn: ({ signal }) =>
      laiosApi.daemonUpdateLog(id as string, log as string, 400, signal),
    enabled: Boolean(id && log),
    refetchInterval: (query) => (query.state.data?.active === false ? false : 1500),
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

// Forget an instance record entirely (best-effort teardown on the daemon).
// Used to clear terminal cards — a failed spin-up or a stopped model — that we
// otherwise keep visible. Optimistically drops the card, rolling back on error.
export function useRemoveInstance(connectionId: string) {
  const qc = useQueryClient()
  const key = laiosKeys.instances(connectionId)
  return useMutation({
    mutationFn: (instanceId: string) =>
      laiosApi.remove(connectionId, instanceId),
    onMutate: async (instanceId) => {
      await qc.cancelQueries({ queryKey: key })
      const previous = qc.getQueryData<LaiosInstance[]>(key)
      qc.setQueryData<LaiosInstance[]>(key, (old) =>
        old?.filter((i) => i.id !== instanceId)
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

// --- Serve manager: track in-flight downloads → spin-ups as visible cards ------
//
// A model has no daemon instance record until *after* it's downloaded and serve
// is called, so downloading models would otherwise be invisible. Downloads are
// daemon pull jobs (polled via useLaiosJobs), which is the source of truth: a
// card shows real byte progress and survives a page reload or navigation.
//
// The daemon owns the download; Lursor owns the serve options and the "start
// the engine once it's downloaded" step. We persist that intent so a refresh
// mid-download still auto-serves when the pull finishes instead of orphaning it.

/** A download/spin-up card, derived from daemon jobs + our serve intents. */
export interface DownloadCard {
  key: string
  recipeId: string
  name: string
  phase: "pulling" | "starting" | "failed"
  /** Live progress, present while the pull job reports bytes. */
  bytesDone?: number
  bytesTotal?: number
  error?: string
}

// A serve we kicked off: the pull job id ties it to the daemon's download; the
// serve input carries the options only Lursor knows. `served` guards the engine
// start so it fires exactly once; `error` turns the card terminal.
interface ServeIntent {
  key: string
  connectionId: string
  recipeId: string
  name: string
  input: LaiosServeInput
  jobId?: string
  served: boolean
  error?: string
}

const INTENTS_KEY = "laios.serveIntents"

function loadIntents(): ServeIntent[] {
  try {
    const raw = localStorage.getItem(INTENTS_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return Array.isArray(parsed) ? (parsed as ServeIntent[]) : []
  } catch {
    return []
  }
}

function saveIntents(intents: ServeIntent[]): void {
  try {
    localStorage.setItem(INTENTS_KEY, JSON.stringify(intents))
  } catch {
    // Storage unavailable/full — degrade to in-memory only (loses resume).
  }
}

export function useServeManager(connectionId: string | undefined) {
  const [intents, setIntents] = useState<ServeIntent[]>(loadIntents)
  const { data: jobs } = useLaiosJobs(connectionId)
  const serveModel = useServeModel(connectionId ?? "")
  // Guards the auto-serve so a re-render (or Strict Mode double-invoke) can't
  // fire serve twice for the same intent before `served` has been flushed.
  const servingRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    saveIntents(intents)
  }, [intents])

  const updateIntent = useCallback((key: string, patch: Partial<ServeIntent>) => {
    setIntents((list) =>
      list.map((it) => (it.key === key ? { ...it, ...patch } : it))
    )
  }, [])

  const removeIntent = useCallback((key: string) => {
    servingRef.current.delete(key)
    setIntents((list) => list.filter((it) => it.key !== key))
  }, [])

  // Match strictly by job id: a stale succeeded job for the same recipe (from a
  // prior pull) must never trigger a premature serve of a fresh request.
  const jobById = useMemo(() => {
    const m = new Map<string, LaiosJob>()
    for (const j of jobs ?? []) m.set(j.id, j)
    return m
  }, [jobs])

  // Reconcile intents against the daemon's jobs: a finished pull either starts
  // the engine (once) or surfaces as a failed card.
  useEffect(() => {
    for (const it of intents) {
      if (it.connectionId !== connectionId) continue
      if (it.served || it.error || !it.jobId) continue
      const job = jobById.get(it.jobId)
      if (!job) continue
      if (job.status === "failed") {
        updateIntent(it.key, { error: job.error || "Download failed" })
        continue
      }
      if (job.status === "succeeded" && !servingRef.current.has(it.key)) {
        servingRef.current.add(it.key)
        updateIntent(it.key, { served: true })
        serveModel
          .mutateAsync(it.input)
          .then((inst) => {
            toast.success(`Serving ${inst.served_name}`)
            removeIntent(it.key)
          })
          .catch((err) => {
            const msg =
              err instanceof Error ? err.message : "Failed to serve model"
            updateIntent(it.key, { error: msg })
            toast.error(msg)
          })
      }
    }
  }, [intents, jobById, connectionId, serveModel, updateIntent, removeIntent])

  const start = useCallback(
    async (input: LaiosServeInput, name: string) => {
      if (!connectionId) return
      const key =
        globalThis.crypto?.randomUUID?.() ?? `${input.recipe}-${Date.now()}`
      setIntents((list) => [
        ...list,
        { key, connectionId, recipeId: input.recipe, name, input, served: false },
      ])
      try {
        // Idempotent on the daemon (fast when already cached). We only need the
        // job id — progress is read off the polled jobs list, not this call.
        const job = await laiosApi.pull(connectionId, input.recipe)
        updateIntent(key, { jobId: job.id })
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Failed to start download"
        updateIntent(key, { error: msg })
        toast.error(msg)
      }
    },
    [connectionId, updateIntent]
  )

  // Derive the cards: our intents (with progress pulled from their job), plus
  // any active pull the daemon is running that we didn't start (e.g. the CLI).
  const downloads = useMemo<DownloadCard[]>(() => {
    const mine = intents.filter((it) => it.connectionId === connectionId)
    const cards: DownloadCard[] = []
    const usedJobIds = new Set<string>()

    for (const it of mine) {
      if (it.error) {
        cards.push({ key: it.key, recipeId: it.recipeId, name: it.name, phase: "failed", error: it.error })
        if (it.jobId) usedJobIds.add(it.jobId)
        continue
      }
      if (it.served) {
        cards.push({ key: it.key, recipeId: it.recipeId, name: it.name, phase: "starting" })
        if (it.jobId) usedJobIds.add(it.jobId)
        continue
      }
      // Still downloading — read progress off the matching job (by id, falling
      // back to an active pull for the same recipe until our POST returns).
      const job =
        (it.jobId ? jobById.get(it.jobId) : undefined) ??
        (jobs ?? []).find(
          (j) =>
            j.kind === "pull" &&
            JOB_ACTIVE.has(j.status) &&
            j.recipe_id === it.recipeId
        )
      if (job) usedJobIds.add(job.id)
      cards.push({
        key: it.key,
        recipeId: it.recipeId,
        name: it.name,
        phase: "pulling",
        bytesDone: job?.bytes_done ?? undefined,
        bytesTotal: job?.bytes_total ?? undefined,
      })
    }

    for (const j of jobs ?? []) {
      if (j.kind !== "pull" || !JOB_ACTIVE.has(j.status) || usedJobIds.has(j.id)) {
        continue
      }
      cards.push({
        key: `job:${j.id}`,
        recipeId: j.recipe_id ?? "",
        name: j.recipe_id ?? "Model",
        phase: "pulling",
        bytesDone: j.bytes_done ?? undefined,
        bytesTotal: j.bytes_total ?? undefined,
      })
    }
    return cards
  }, [intents, jobs, jobById, connectionId])

  const dismiss = useCallback(
    (key: string) => removeIntent(key),
    [removeIntent]
  )

  return { downloads, start, dismiss }
}
