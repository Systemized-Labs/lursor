import { useMemo } from "react"
import { create } from "zustand"

/**
 * A background process the agent started with `run_in_background` (a dev server,
 * a watcher, …), mirrored from the workspace's live process feed (see backend
 * `preview_service.py`). Only *running* processes appear; one that exits drops
 * out of the next snapshot.
 *
 * `url`/`port` are set once a served address is parsed from stdout; `ready`
 * flips true once that URL answers HTTP. `id` is a stable composite key used to
 * kill or read the process.
 */
export interface BackgroundProcess {
  id: string
  shellId: string
  command: string
  /** Epoch seconds the process was first seen — used for elapsed running time. */
  startedAt: number
  url: string | null
  port: number | null
  ready: boolean
}

/** A dev server derived from a background process that advertised a URL. */
export interface DetectedServer {
  shellId: string
  url: string
  port: number
  command: string
  status: "starting" | "ready"
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
          status: p.ready ? ("ready" as const) : ("starting" as const),
        })),
    [processes]
  )
}
