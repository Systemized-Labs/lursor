import { useSyncExternalStore } from "react"

/**
 * Thread ids the client believes are running *right now* because it just fired a
 * send — before the 3s `useActiveRuns` poll has observed the server-side run.
 * Unioning this into the polled set lets the sidebar flip to "working" the
 * instant you hit send, then hands authority back to the poll once the run
 * settles.
 *
 * Kept separate from the react-query cache on purpose: an in-flight poll can
 * return pre-run data and would clobber an optimistic write to that cache. This
 * store is only ever mutated by the send lifecycle, so nothing races it.
 */

let runs = new Set<string>()
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Flag a thread as running the moment its send begins. */
export function markRunStarted(id: string) {
  if (runs.has(id)) return
  runs = new Set(runs).add(id)
  emit()
}

/** Drop the optimistic flag once the send settles; the poll takes over. */
export function markRunSettled(id: string) {
  if (!runs.has(id)) return
  const next = new Set(runs)
  next.delete(id)
  runs = next
  emit()
}

export function useOptimisticRuns() {
  return useSyncExternalStore(subscribe, () => runs)
}
