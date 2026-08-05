import { api, connectWs } from "./client"

import type { BackgroundProcess } from "@/lib/processes"

/** A full-snapshot message from the process feed. */
export interface ProcessSnapshot {
  processes: BackgroundProcess[]
}

/** Open a workspace's background-process feed. */
export function connectPreviewWs(workspaceId: string): WebSocket {
  return connectWs(`/workspaces/${workspaceId}/preview/ws`)
}

/** Stop a running background process. */
export function killProcess(
  workspaceId: string,
  id: string
): Promise<{ killed: boolean }> {
  return api.post(
    `/workspaces/${workspaceId}/preview/kill?id=${encodeURIComponent(id)}`,
    undefined
  )
}

/** Fetch a background process's captured output tail. */
export function fetchProcessOutput(
  workspaceId: string,
  id: string
): Promise<{ output: string }> {
  return api.get(
    `/workspaces/${workspaceId}/preview/output?id=${encodeURIComponent(id)}`
  )
}
