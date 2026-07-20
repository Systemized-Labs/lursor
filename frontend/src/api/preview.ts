import { API_BASE, api } from "./client"

import type { BackgroundProcess } from "@/lib/processes"

/** A full-snapshot message from the process feed. */
export interface ProcessSnapshot {
  processes: BackgroundProcess[]
}

/** Build the WebSocket URL for a workspace's background-process feed. */
export function previewWsUrl(workspaceId: string): string {
  const url = new URL(
    `${API_BASE.replace(/\/$/, "")}/workspaces/${workspaceId}/preview/ws`
  )
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.toString()
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
