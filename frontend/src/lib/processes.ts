import { useMemo } from "react"
import { create } from "zustand"

/**
 * How a background process is currently doing.
 *
 * - `running` — live, but never advertised an address (a watcher, an ffmpeg job).
 * - `starting` — printed a URL that hasn't answered yet.
 * - `ready` — answering right now.
 * - `unhealthy` — was answering and has stopped. The process is still alive, so
 *   it stays in the list; it is the *service* that is down.
 */
export type ProcessStatus = "running" | "starting" | "ready" | "unhealthy"

/**
 * A background process the agent started with `run_in_background` (a dev server,
 * a watcher, …), mirrored from the workspace's live process feed (see backend
 * `preview_service.py`). Only *running* processes appear; one that exits drops
 * out of the next snapshot.
 *
 * `url`/`port` are set once a served address is parsed from stdout, and are
 * followed if the server later moves. `id` is a stable composite key used to kill
 * or read the process — but it identifies the *process*, so it changes across a
 * restart; `serviceKey` is what stays the same.
 */
export interface BackgroundProcess {
  id: string
  shellId: string
  command: string
  /** Epoch seconds the process was first seen — used for elapsed running time. */
  startedAt: number
  /**
   * Which service this process provides, inferred from its command (see backend
   * `service_key.py`). Stable across a restart, so the preview can follow a
   * server that came back on a different port.
   */
  serviceKey: string
  url: string | null
  port: number | null
  status: ProcessStatus
  /** `status === "ready"`. Retained because it reads better at call sites. */
  ready: boolean
}

/** A dev server derived from a background process that advertised a URL. */
export interface DetectedServer {
  shellId: string
  url: string
  port: number
  command: string
  serviceKey: string
  status: Exclude<ProcessStatus, "running">
}

interface ProcessesState {
  /** Running background processes per workspace id. Feed-derived, not persisted. */
  byWorkspace: Record<string, BackgroundProcess[]>
  /** Replace a workspace's process list wholesale (full snapshot from the feed). */
  replace: (workspaceId: string, processes: BackgroundProcess[]) => void
  /** Drop all processes for a workspace (e.g. on disconnect). */
  clear: (workspaceId: string) => void
}

/**
 * Module-level store, keyed by workspace. Intentionally in-memory: the list is
 * derived from the live feed, so a hard refresh clears it until the WebSocket
 * re-subscribes and the service replays the current snapshot.
 */
export const useProcessesStore = create<ProcessesState>((set) => ({
  byWorkspace: {},
  replace: (workspaceId, processes) =>
    set((state) => {
      // Stable order by command so rows don't jump as ready-state flips.
      const next = [...processes].sort((a, b) =>
        a.command.localeCompare(b.command)
      )
      return { byWorkspace: { ...state.byWorkspace, [workspaceId]: next } }
    }),
  clear: (workspaceId) =>
    set((state) => {
      if (!state.byWorkspace[workspaceId]) return state
      const { [workspaceId]: _dropped, ...rest } = state.byWorkspace
      return { byWorkspace: rest }
    }),
}))

const EMPTY: BackgroundProcess[] = []

/** Selector hook: the running background processes for one workspace. */
export function useWorkspaceProcesses(
  workspaceId: string | undefined
): BackgroundProcess[] {
  return useProcessesStore((s) =>
    workspaceId ? s.byWorkspace[workspaceId] ?? EMPTY : EMPTY
  )
}

/** Derived: the subset of processes that advertised a URL, as preview servers. */
export function usePreviewServersFor(
  workspaceId: string | undefined
): DetectedServer[] {
  const processes = useWorkspaceProcesses(workspaceId)
  return useMemo(
    () =>
      processes
        .filter((p): p is BackgroundProcess & { url: string; port: number } =>
          Boolean(p.url)
        )
        .map((p) => ({
          shellId: p.id,
          url: p.url,
          port: p.port,
          command: p.command,
          serviceKey: p.serviceKey,
          // A process that advertised a URL is never plain `running`; the guard
          // covers a backend older than the status field.
          status:
            p.status && p.status !== "running"
              ? p.status
              : p.ready
                ? ("ready" as const)
                : ("starting" as const),
        })),
    [processes]
  )
}
