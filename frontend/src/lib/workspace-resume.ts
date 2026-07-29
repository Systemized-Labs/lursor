import type { Thread } from "@/api/types"

export const WORKSPACE_VISITS_KEY = "lursor:workspace-visits"

/** Where you were in a workspace, and when you were last there. */
export interface Visit {
  /** The conversation that was open, or null if you were on a fresh composer. */
  threadId: string | null
  /** Epoch ms of the visit — orders the MRU chain. */
  at: number
}

export type Visits = Record<string, Visit>

/** Parse the stored visit record, tolerating anything that isn't one. */
export function readVisits(): Visits {
  if (typeof window === "undefined") return {}
  try {
    const raw = window.localStorage.getItem(WORKSPACE_VISITS_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const out: Visits = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue
      const { threadId, at } = value as Partial<Visit>
      if (typeof at !== "number") continue
      out[id] = { threadId: typeof threadId === "string" ? threadId : null, at }
    }
    return out
  } catch {
    return {}
  }
}

export function writeVisits(visits: Visits): void {
  try {
    window.localStorage.setItem(WORKSPACE_VISITS_KEY, JSON.stringify(visits))
  } catch {
    // Ignore quota / disabled-storage errors — resume state is best-effort.
  }
}

/** Workspace ids from a visit record, most recently visited first. */
export function mruOrder(visits: Visits): string[] {
  return Object.entries(visits)
    .sort((a, b) => b[1].at - a[1].at)
    .map(([id]) => id)
}

/**
 * The URL that returns you to a workspace where you left off.
 *
 * `/workspaces/:id/chat` with no `?c=` is a blank composer, so the obvious route
 * lands you on an empty conversation — which is why returning to a workspace
 * never felt like returning. Three fallbacks, in order: the conversation you
 * actually had open, else that workspace's most recent one, else the blank
 * composer, which by then is the honest answer because there is nothing to
 * resume.
 *
 * The remembered id is checked against the live list first. It can have been
 * deleted from another window, and pointing `?c=` at a thread that no longer
 * exists is worse than the blank composer — the chat page would try to load it
 * and surface an error instead of a conversation.
 *
 * Shared by the rail and the command palette so the two can't disagree about
 * where a workspace's "home" is.
 */
export function resumeHref(
  workspaceId: string,
  threads: Thread[],
  visits: Visits
): string {
  const base = `/workspaces/${workspaceId}/chat`
  const remembered = visits[workspaceId]?.threadId
  const resume =
    remembered && threads.some((t) => t.id === remembered)
      ? remembered
      : threads[0]?.id
  return resume ? `${base}?c=${resume}` : base
}
