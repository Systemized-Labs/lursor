import { useEffect, useRef } from "react"

import { gitWatchWsUrl } from "@/api/git"

/**
 * Subscribe to a workspace's git-watch WebSocket, invoking `onChange` whenever
 * the backend reports a git-state transition — a commit, staging, branch switch,
 * or merge/rebase/reset.
 *
 * Complements {@link useFileWatch}: that socket streams working-tree file edits
 * (which the diff also reacts to), but it can't see changes inside `.git/`.
 * Together they keep the Changes panel live without a manual refresh.
 *
 * The socket reconnects with exponential backoff. `onChange` is held in a ref so
 * a caller passing a fresh closure each render never forces a reconnect — the
 * socket only re-opens when `workspaceId` changes.
 */
export function useGitWatch(
  workspaceId: string | undefined,
  onChange: () => void
) {
  const cbRef = useRef(onChange)
  useEffect(() => {
    cbRef.current = onChange
  }, [onChange])

  useEffect(() => {
    if (!workspaceId) return
    let socket: WebSocket | null = null
    let reconnect: ReturnType<typeof setTimeout> | undefined
    let closed = false
    let delay = 1000
    const MAX_DELAY = 30000

    const connect = () => {
      const openedAt = Date.now()
      socket = new WebSocket(gitWatchWsUrl(workspaceId))
      socket.onmessage = () => cbRef.current()
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
