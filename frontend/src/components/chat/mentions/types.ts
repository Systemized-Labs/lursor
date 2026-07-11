import type { LucideIcon } from "lucide-react"

/** A single referenceable entity within a mention category. */
export interface MentionItem {
  /** Stable entity id (agent id, skill id, file path, …). */
  id: string
  /** Human-facing display name. */
  label: string
  /** URL-ish segment used in the inserted token (`@/<category>/<slug>`). */
  slug: string
  /** Secondary text shown dimmed beside the label (status, kind, …). */
  sublabel?: string
  /** When true, selecting drills deeper (e.g. a directory) instead of
   *  completing the mention. */
  container?: boolean
}

/** A category of referenceable things, plugged into a chat surface. Provide
 *  exactly one of `items` (in-memory, root-searchable) or `browse`
 *  (hierarchical / lazy, category-only). */
export interface MentionSource {
  /** Category key — first path segment of the token (`@/<key>/…`). */
  key: string
  /** Category display label. */
  label: string
  icon: LucideIcon
  /** Pre-loaded items, filtered locally and surfaced at the root level. */
  items?: MentionItem[]
  /** Lazy/hierarchical lookup. Receives the path query after `@/<key>/` and
   *  returns the matching children (directories flagged `container`). */
  browse?: (pathQuery: string) => Promise<MentionItem[]>
}

/** A mention the user committed, carried alongside the message text so backend
 *  tools can resolve the exact entity. */
export interface ResolvedMention {
  /** Source category key (`agent`, `skill`, `file`, …). */
  type: string
  id: string
  label: string
  /** The literal token inserted into the text, e.g. `@/agents/coder`. */
  ref: string
}

/** The active `@…` token under the caret. */
export interface ActiveMention {
  /** Index of the `@` in the text. */
  start: number
  /** Caret index (token end, exclusive). */
  end: number
  /** Raw text between `@` and the caret (may contain `/`). */
  query: string
}

const SLUG_MAX = 48

/** Derive a readable, stable-ish slug from a display name. */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return (slug || "item").slice(0, SLUG_MAX)
}

/** Locate the `@…` mention token immediately preceding `caret`, if any. A
 *  trigger is only active when `@` sits at a word boundary and no whitespace
 *  separates it from the caret. */
export function findActiveMention(text: string, caret: number): ActiveMention | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === "@") {
      const prev = i > 0 ? text[i - 1] : ""
      if (i === 0 || /\s/.test(prev)) {
        const query = text.slice(i + 1, caret)
        if (/\s/.test(query)) return null
        return { start: i, end: caret, query }
      }
      return null
    }
    if (/\s/.test(ch)) return null
  }
  return null
}

/** Split a mention query into its category key and the remaining sub-query.
 *  A leading slash is optional, so `@/agents/co` and `@agents/co` are equal. */
export function parseMentionQuery(query: string): { categoryKey: string | null; sub: string } {
  const q = query.startsWith("/") ? query.slice(1) : query
  const slash = q.indexOf("/")
  if (slash === -1) return { categoryKey: null, sub: q }
  return { categoryKey: q.slice(0, slash), sub: q.slice(slash + 1) }
}
