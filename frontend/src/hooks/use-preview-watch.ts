import { useEffect } from "react"

import { connectPreviewWs, type ProcessSnapshot } from "@/api/preview"
import { requestOpenPreview } from "@/lib/open-preview"
import { useProcessesStore } from "@/lib/processes"

/**
 * Keep the processes store in sync with a workspace's live background-process
 * feed. The backend streams full snapshots as processes the agent starts come
 * up (and drop off), so we replace the workspace's list on each message — a
 * process that vanishes from the snapshot removes its entry.
 *
 * Mounted once for the active workspace (in the app shell), so processes are
 * known app-wide regardless of whether the Preview panel is open. Reconnects
 * with exponential backoff, mirroring {@link useFileWatch}; the store is cleared
 * for the workspace on teardown so stale entries never linger after a switch.
 *
 * The first dev server to reach `ready` auto-opens the Preview panel (reveals
 * the dock + a preview tab, via {@link requestOpenPreview}) so "spin up the
 * preview" just works. Only the first is auto-opened per workspace visit — later
 * servers (and re-opens after the user closes the panel) stay one-tap chips, so
 * it never fights the user for focus.
 */
export function usePreviewWatch(workspaceId: string | undefined) {
  useEffect(() => {
    if (!workspaceId) return
    const { replace, clear } = useProcessesStore.getState()
    let autoOpened = false
    let socket: WebSocket | null = null
    let reconnect: ReturnType<typeof setTimeout> | undefined
    let closed = false
    let delay = 1000
    const MAX_DELAY = 30000

    const connect = () => {
      const openedAt = Date.now()
      socket = connectPreviewWs(workspaceId)
      socket.onmessage = (event) => {
        let snapshot: ProcessSnapshot
        try {
          snapshot = JSON.parse(event.data as string)
        } catch {
          return
        }
        const processes = snapshot.processes ?? []
        replace(workspaceId, processes)
        if (!autoOpened) {
          const ready = processes.find((p) => p.url && p.ready)
          if (ready?.url) {
            autoOpened = true
            requestOpenPreview({ workspaceId, url: ready.url })
          }
        }
      }
      socket.onclose = () => {
        if (closed) return
        if (Date.now() - openedAt > 10000) delay = 1000
        reconnect = setTimeout(connect, delay)
        delay = Math.min(delay * 2, MAX_DELAY)
      }
    }
    connect()

    return () => {
      closed = true
      if (reconnect) clearTimeout(reconnect)
      socket?.close()
      clear(workspaceId)
    }
  }, [workspaceId])
}
