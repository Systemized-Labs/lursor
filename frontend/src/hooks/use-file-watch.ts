import { useEffect, useRef } from "react"

import { fileWatchWsUrl } from "@/api/files"
import type { FileChange } from "@/api/files"

/**
 * Subscribe to a workspace's file-watch WebSocket, invoking `onChanges` with
 * each non-empty batch of filesystem changes the backend streams as the agent
 * (or anyone else) touches the directory.
 *
 * The socket reconnects with exponential backoff so a connection that fails
 * immediately (e.g. no workspace directory) doesn't spin in a tight loop, while
 * a connection that survived a while is treated as a transient drop and recovers
 * fast. `onChanges` is held in a ref, so a caller passing a fresh closure each
 * render never forces a reconnect — the socket only re-opens when `workspaceId`
 * changes.
 */
export function useFileWatch(
  workspaceId: string | undefined,
  onChanges: (changes: FileChange[]) => void
) {
  const cbRef = useRef(onChanges)
  useEffect(() => {
    cbRef.current = onChanges
  }, [onChanges])

  useEffect(() => {
    if (!workspaceId) return
    let socket: WebSocket | null = null
    let reconnect: ReturnType<typeof setTimeout> | undefined
    let closed = false
    let delay = 1000
    const MAX_DELAY = 30000

    const connect = () => {
      const openedAt = Date.now()
      socket = new WebSocket(fileWatchWsUrl(workspaceId))
      socket.onmessage = (event) => {
        let batch: { changes?: FileChange[] }
        try {
          batch = JSON.parse(event.data as string)
        } catch {
          return
        }
        const changes = batch.changes ?? []
        if (changes.length > 0) cbRef.current(changes)
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
    }
  }, [workspaceId])
}
