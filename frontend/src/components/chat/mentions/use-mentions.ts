import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react"

import {
  type ActiveMention,
  type MentionItem,
  type MentionSource,
  type ResolvedMention,
  findActiveMention,
  parseMentionQuery,
} from "./types"

export type MenuRow =
  | { kind: "category"; source: MentionSource }
  | { kind: "item"; source: MentionSource; item: MentionItem }

const ROOT_ITEMS_PER_SOURCE = 4
const ROOT_BROWSE_ITEMS = 8
const MAX_CATEGORY_ITEMS = 50
const BROWSE_DEBOUNCE_MS = 120

function matches(item: MentionItem, sub: string): boolean {
  if (!sub) return true
  const q = sub.toLowerCase()
  // Match on the name (label) and slug only — not the sublabel. Sublabels carry
  // descriptions/status, and matching a word buried in a sentence is too loose.
  return item.label.toLowerCase().includes(q) || item.slug.toLowerCase().includes(q)
}

function filterItems(items: MentionItem[], sub: string): MentionItem[] {
  if (!sub) return items
  const q = sub.toLowerCase()
  // Prefix matches first, then other substring matches.
  return items
    .filter((it) => matches(it, sub))
    .sort(
      (a, b) =>
        Number(b.label.toLowerCase().startsWith(q)) -
        Number(a.label.toLowerCase().startsWith(q))
    )
}

/** Relevance of a row against the query, used to order the root menu across
 *  sources so the strongest name match wins regardless of where it came from.
 *  Higher is better. Folder labels carry a trailing slash, which is ignored. */
function rowScore(row: MenuRow, sub: string): number {
  const q = sub.toLowerCase()
  const raw = row.kind === "category" ? row.source.label : row.item.label
  const name = raw.toLowerCase().replace(/\/+$/, "")
  if (name === q) return 100
  if (name.startsWith(q)) return 80
  const idx = name.indexOf(q)
  if (idx > 0 && /[^a-z0-9]/.test(name[idx - 1])) return 60 // start of a word inside the name
  if (idx >= 0) return 40 // substring elsewhere in the name
  return 10 // matched via slug/path only — not in the visible name
}

export interface UseMentionsOptions {
  value: string
  setValue: (value: string) => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
  sources: MentionSource[]
  onResolve?: (mention: ResolvedMention) => void
  enabled?: boolean
}

export function useMentions({
  value,
  setValue,
  textareaRef,
  sources,
  onResolve,
  enabled = true,
}: UseMentionsOptions) {
  const [caret, setCaret] = useState(0)
  const [activeIndex, setActiveIndex] = useState(0)
  const [dismissedStart, setDismissedStart] = useState<number | null>(null)
  const [browseRows, setBrowseRows] = useState<MenuRow[]>([])
  const [browseLoading, setBrowseLoading] = useState(false)

  const hasSources = enabled && sources.length > 0

  // Re-read the caret from the textarea after any event that can move it.
  const refresh = useCallback(() => {
    setCaret(textareaRef.current?.selectionStart ?? 0)
  }, [textareaRef])

  const active: ActiveMention | null = useMemo(
    () => (hasSources ? findActiveMention(value, caret) : null),
    [hasSources, value, caret]
  )

  const parsed = useMemo(() => (active ? parseMentionQuery(active.query) : null), [active])
  const category = useMemo(
    () => (parsed?.categoryKey ? sources.find((s) => s.key === parsed.categoryKey) ?? null : null),
    [parsed, sources]
  )
  const mode: "root" | "category" = category ? "category" : "root"
  const sub = parsed?.sub ?? ""

  // Reset transient menu state whenever the query changes.
  useEffect(() => {
    setActiveIndex(0)
    setDismissedStart(null)
  }, [active?.query])

  // Sources to query lazily: the active browse category, or — at the root —
  // every browse-capable source, so a bare `@query` searches files/folders too
  // without first picking the Files category.
  const browseTargets = useMemo<{ source: MentionSource; query: string }[]>(() => {
    if (mode === "category" && category?.browse) return [{ source: category, query: sub }]
    if (mode === "root" && sub) {
      return sources.filter((s) => s.browse).map((s) => ({ source: s, query: sub }))
    }
    return []
  }, [mode, category, sub, sources])

  // Fetch browse results on query change, debounced. Each source's items are
  // tagged with their source so selection resolves the right category.
  useEffect(() => {
    if (browseTargets.length === 0) {
      setBrowseRows([])
      setBrowseLoading(false)
      return
    }
    let cancelled = false
    setBrowseLoading(true)
    const handle = setTimeout(() => {
      Promise.all(
        browseTargets.map((t) =>
          t.source
            .browse!(t.query)
            .then((items) =>
              items.map((item) => ({ kind: "item" as const, source: t.source, item }))
            )
            .catch(() => [] as MenuRow[])
        )
      )
        .then((groups) => {
          if (!cancelled) setBrowseRows(groups.flat())
        })
        .finally(() => {
          if (!cancelled) setBrowseLoading(false)
        })
    }, BROWSE_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [browseTargets])

  const rows = useMemo<MenuRow[]>(() => {
    if (!active) return []
    if (mode === "category" && category) {
      if (category.items) {
        return filterItems(category.items, sub)
          .slice(0, MAX_CATEGORY_ITEMS)
          .map((item) => ({ kind: "item" as const, source: category, item }))
      }
      return browseRows
    }
    // Root: matching categories first, then top item hits from in-memory
    // sources, then a few live hits from browse sources (so `@app` surfaces a
    // file/folder without first picking the Files category).
    const cats: MenuRow[] = sources
      .filter(
        (s) =>
          !sub ||
          s.label.toLowerCase().includes(sub.toLowerCase()) ||
          s.key.includes(sub.toLowerCase())
      )
      .map((source) => ({ kind: "category" as const, source }))
    const items: MenuRow[] = sub
      ? sources.flatMap((source) =>
          source.items
            ? filterItems(source.items, sub)
                .slice(0, ROOT_ITEMS_PER_SOURCE)
                .map((item) => ({ kind: "item" as const, source, item }))
            : []
        )
      : []
    const combined = [...cats, ...items, ...browseRows.slice(0, ROOT_BROWSE_ITEMS)]
    if (!sub) return combined
    // Order by relevance across all sources (stable on ties, preserving the
    // server's file ranking) so an exact file/folder name beats a weaker hit.
    return combined
      .map((row, i) => ({ row, i, score: rowScore(row, sub) }))
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map((entry) => entry.row)
  }, [active, mode, category, sub, browseRows, sources])

  const open =
    active !== null && active.start !== dismissedStart && (rows.length > 0 || browseLoading)

  const clampedIndex = rows.length ? Math.min(activeIndex, rows.length - 1) : 0

  // Replace the active `@…` token with `token`, then restore focus + caret.
  const replaceToken = useCallback(
    (token: string) => {
      if (!active) return
      const next = value.slice(0, active.start) + token + value.slice(active.end)
      const newCaret = active.start + token.length
      setValue(next)
      setCaret(newCaret)
      requestAnimationFrame(() => {
        const el = textareaRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(newCaret, newCaret)
      })
    },
    [active, value, setValue, textareaRef]
  )

  const selectRow = useCallback(
    (row: MenuRow) => {
      if (row.kind === "category") {
        replaceToken(`@/${row.source.key}/`)
        return
      }
      const { source, item } = row
      if (item.container) {
        replaceToken(`@/${source.key}/${item.slug}/`)
        return
      }
      const ref = `@/${source.key}/${item.slug}`
      replaceToken(`${ref} `)
      onResolve?.({ type: source.key, id: item.id, label: item.label, ref })
    },
    [replaceToken, onResolve]
  )

  const close = useCallback(() => {
    if (active) setDismissedStart(active.start)
  }, [active])

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open || !rows.length) return false
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault()
          setActiveIndex((i) => (i + 1) % rows.length)
          return true
        case "ArrowUp":
          e.preventDefault()
          setActiveIndex((i) => (i - 1 + rows.length) % rows.length)
          return true
        case "Enter":
        case "Tab":
          e.preventDefault()
          selectRow(rows[clampedIndex])
          return true
        case "Escape":
          e.preventDefault()
          close()
          return true
        default:
          return false
      }
    },
    [open, rows, clampedIndex, selectRow, close]
  )

  return {
    open,
    rows,
    mode,
    category,
    sub,
    loading: browseLoading,
    activeIndex: clampedIndex,
    setActiveIndex,
    selectRow,
    onKeyDown,
    refresh,
    close,
  }
}
