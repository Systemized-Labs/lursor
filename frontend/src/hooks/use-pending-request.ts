import { useEffect, useRef, useState } from "react"

import type { RequestChannel } from "@/lib/request-channel"

/**
 * Route a parked request to whatever answers it, once, when this shell can.
 *
 * The plumbing every {@link RequestChannel} needs on the receiving end, which the
 * shell used to write out three times: a tick to re-run on, a peek, a workspace-id
 * match, and a guard on request identity. About 55 lines wrapped around three
 * genuinely different handlers.
 *
 * **`handle` is called once per request, not once per matching render.** The guard is
 * on the request *object*, which is what makes it work: a re-render peeks the same
 * object and does nothing, while a new request — even an identical one for the same
 * file — is a new object and opens again. Which is why the channel parks the object
 * rather than its fields.
 *
 * The handler is not required to consume. Some do (a conversation is opened by the
 * shell, so nothing else will), some leave it parked for the surface that is about to
 * mount (a Preview pane reads its own URL out of the channel once it exists). That
 * choice belongs to the handler, so `consume` is not called here.
 *
 * `ready` is "this shell can answer it now", and it is what keeps a request from
 * being marked handled by a shell that cannot act on it yet. The pane host is
 * lazy-loaded, so on a slow connection a request can arrive before dockview exists —
 * without the gate the request is consumed by a no-op and never opens.
 *
 * `handle` should be stable (a `useCallback`), or the effect re-runs on every render.
 * It is harmless when it does — the identity guard absorbs it — but the point of
 * memoising `usePaneLayout`'s return was to stop paying for that.
 */
export function usePendingRequest<T extends { workspaceId: string }>(
  channel: RequestChannel<T>,
  workspaceId: string | undefined,
  ready: boolean,
  handle: (request: T) => void
): void {
  const [tick, setTick] = useState(0)
  const handled = useRef<T | null>(null)

  useEffect(() => channel.subscribe(() => setTick((t) => t + 1)), [channel])

  useEffect(() => {
    if (!ready) return
    const pending = channel.peek()
    if (!pending || pending.workspaceId !== workspaceId) return
    if (handled.current === pending) return
    handled.current = pending
    handle(pending)
  }, [channel, tick, workspaceId, ready, handle])
}
