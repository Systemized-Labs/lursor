import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, ApiError } from "./client"
import { fsKeys } from "./fs"

/**
 * The *backend's* update stream.
 *
 * Separate from the desktop client's (`hooks/use-desktop-update.ts`, which talks to
 * Electron over IPC) because over a remote connection they genuinely are two
 * independent things: the client updates itself from GitHub, the backend updates
 * itself in place on its own host, and either can be newer than the other.
 *
 * Inert against a local backend, where the frozen copy inside the app bundle is
 * replaced by the client update and `self_updatable` is always false.
 */

export interface BackendUpdateStatus {
  version: string
  install_kind: "bundled" | "checkout"
  managed_by: "desktop" | "service" | "none"
  self_updatable: boolean
  self_update_blocked_reason: string | null
  platform: string
  repo: string
  pinned_ref: string | null
  git: { ref: string | null; commit: string } | null
  last_update: BackendUpdateJob | null
}

export interface BackendUpdateJob {
  state: "running" | "ok" | "failed"
  started_at: number
  finished_at: number | null
  from_version: string
  target_ref: string
  returncode: number | null
  runner?: "systemd-run" | "detached"
  runner_note?: string
  error?: string
}

export interface BackendUpdateCheck {
  current: string
  latest: string | null
  update_available: boolean
  error: string | null
}

export const updateApi = {
  status: (signal?: AbortSignal) =>
    api.get<BackendUpdateStatus>("/update/status", signal),
  check: (signal?: AbortSignal) => api.get<BackendUpdateCheck>("/update/check", signal),
  start: () =>
    api.post<{ started: boolean; state: BackendUpdateJob | null }>("/update", {}),
  log: (tail = 400, signal?: AbortSignal) =>
    api.get<{ log: string; state: BackendUpdateJob | null }>(
      `/update/log?tail=${tail}`,
      signal
    ),
}

export const updateKeys = {
  all: ["update"] as const,
  status: () => ["update", "status"] as const,
  check: () => ["update", "check"] as const,
  log: () => ["update", "log"] as const,
}

/** Local facts about the backend. Cheap — no network on the host's side. */
export function useBackendUpdateStatus(enabled = true) {
  return useQuery({
    queryKey: updateKeys.status(),
    queryFn: ({ signal }) => updateApi.status(signal),
    enabled,
    retry: false,
    staleTime: 30_000,
  })
}

/**
 * On-demand "is there a newer release?".
 *
 * `enabled: false` and driven by `refetch()`, mirroring `useLaiosUpdateCheck`: each
 * call is a GitHub round trip from the backend, against an unauthenticated rate limit
 * of 60/hour for the whole host.
 */
export function useBackendUpdateCheck() {
  return useQuery({
    queryKey: updateKeys.check(),
    queryFn: ({ signal }) => updateApi.check(signal),
    enabled: false,
    retry: false,
    gcTime: 60_000,
  })
}

/** Tail of the running (or last) update job. Polls only while it is open and active. */
export function useBackendUpdateLog(enabled: boolean) {
  return useQuery({
    queryKey: updateKeys.log(),
    queryFn: ({ signal }) => updateApi.log(400, signal),
    enabled,
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.state?.state === "running" ? 1500 : false,
  })
}

/**
 * Start the backend's self-update.
 *
 * **A failed request here usually means success.** The job restarts the service,
 * which kills the process holding this connection, so the 202 may never arrive. The
 * backend writes its state to disk before spawning anything precisely so that the
 * truth is recoverable afterwards — so treat a transport failure as "started" and let
 * the reconnect poll settle it. This is the same reading `api/laios.py` applies to a
 * daemon restart that drops its own reply.
 */
export function useStartBackendUpdate() {
  return useMutation({
    mutationFn: async () => {
      try {
        return await updateApi.start()
      } catch (err) {
        // A refusal is a real answer and must surface: the backend replies 409 with
        // the reason *before* it spawns anything, so it is demonstrably still
        // reachable. Only a transport-level failure is the ambiguous case.
        if (err instanceof ApiError) throw err
        return { started: true, state: null }
      }
    },
  })
}

/**
 * Module-scope signal for "an update just started, start watching".
 *
 * The watcher has to be owned by something mounted on every route, so that closing
 * the dialog you started the update from doesn't abandon the poll. But the update can
 * be started from more than one place — the indicator's dialog and the same dialog
 * opened from Settings. A module-scope notify decouples the two, the way
 * `subscribeUnauthorized` in `api/client.ts` already does for 401s.
 */
let reconnectListener: (() => void) | null = null

/** Ask whoever owns the reconnect watch to start it. Safe to call with no listener. */
export function requestBackendReconnectWatch(): void {
  reconnectListener?.()
}

/**
 * Follow the backend through the restart an update causes.
 *
 * Mount this once, somewhere always-mounted; anything can then trigger it through
 * `requestBackendReconnectWatch`.
 *
 * Two things here are less obvious than they look, both learned by `useDaemonReconnect`:
 * a restart can be faster than the poll, so "never saw it go down" needs a settle
 * window rather than being treated as failure; and the version has to be invalidated
 * explicitly at the end because `useServerInfo` is cached with `staleTime: Infinity`
 * on the (otherwise correct) grounds that it cannot change without a restart.
 */
export function useBackendReconnect() {
  const qc = useQueryClient()
  const [watching, setWatching] = useState(false)

  useEffect(() => {
    reconnectListener = () => setWatching(true)
    return () => {
      reconnectListener = null
    }
  }, [])

  useEffect(() => {
    if (!watching) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const startedAt = Date.now()
    const POLL_MS = 800
    const DEADLINE_MS = 180_000
    const MIN_SETTLE_MS = 3_000
    let sawDown = false

    const finish = (ok: boolean) => {
      if (cancelled) return
      cancelled = true
      clearTimeout(timer)
      setWatching(false)
      // The token survives an update (`ensure_token` reuses ~/.lursor/token unless
      // asked to rotate), so nothing needs re-authenticating — only re-reading.
      qc.invalidateQueries({ queryKey: fsKeys.serverInfo() })
      qc.invalidateQueries({ queryKey: updateKeys.all })
      qc.invalidateQueries({ queryKey: ["connection", "health"] })
      if (ok) toast.success("Backend back online")
      else
        toast.error(
          "The backend hasn't come back yet. It may still be syncing dependencies — check its update log."
        )
    }

    const tick = async () => {
      if (cancelled) return
      let healthy = false
      try {
        await api.get<{ status: string }>("/health")
        healthy = true
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
  }, [watching, qc])

  return { reconnecting: watching }
}
