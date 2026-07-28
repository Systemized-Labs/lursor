import { useCallback, useSyncExternalStore } from "react"

/**
 * Tracks which conversations the user has "seen up to", so the sidebar can flag
 * a thread whose latest reply landed *after* it was last opened — i.e. a run
 * that finished while you were looking elsewhere.
 *
 * The record maps thread id → the `updated_at` we last saw as read. A thread is
 * unread when its current `updated_at` is newer than that mark. State lives in
 * localStorage (per device, best-effort) — there's no server-side read receipt.
 */

const STORAGE_KEY = "lursor:thread-reads"

/** threadId → last-seen `updated_at` (ISO string). */
type Reads = Record<string, string>

function load(): Reads {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Reads) : {}
  } catch {
    return {}
  }
}

let reads: Reads = load()
const listeners = new Set<() => void>()

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(reads))
  } catch {
    // Ignore quota / disabled-storage errors — read state is best-effort.
  }
}

function emit() {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function newer(a: string, b: string): boolean {
  return new Date(a).getTime() > new Date(b).getTime()
}

/**
 * Mark a thread read up to `updatedAt` (call when it's the open conversation).
 * Advances the mark so activity that lands while you're watching stays read.
 */
export function markThreadRead(id: string, updatedAt: string) {
  if (reads[id] === updatedAt) return
  reads = { ...reads, [id]: updatedAt }
  persist()
  emit()
}

/**
 * Record a thread on first sight without flagging it. Seeding at its current
 * `updated_at` means only *future* activity marks it unread — a thread that was
 * already busy before this device ever saw it isn't retroactively highlighted.
 */
export function seedThreadRead(id: string, updatedAt: string) {
  if (reads[id] !== undefined) return
  reads = { ...reads, [id]: updatedAt }
  persist()
  emit()
}

/**
 * Seed a whole list in one pass. The per-thread version clones the record,
 * re-serialises it and notifies every subscriber on each call, so seeding a few
 * hundred threads one at a time is quadratic string work and a few hundred
 * synchronous storage writes — on first load, before anything has painted.
 * This does the same job with one write and one notification.
 */
export function seedThreadReads(threads: { id: string; updated_at: string }[]) {
  let next: Reads | null = null
  for (const thread of threads) {
    if (reads[thread.id] !== undefined) continue
    next ??= { ...reads }
    next[thread.id] = thread.updated_at
  }
  if (!next) return
  reads = next
  persist()
  emit()
}

export function useThreadReads() {
  const snapshot = useSyncExternalStore(subscribe, () => reads)

  const isUnread = useCallback(
    (id: string, updatedAt: string) => {
      const seen = snapshot[id]
      return seen !== undefined && newer(updatedAt, seen)
    },
    [snapshot]
  )

  return { isUnread }
}
