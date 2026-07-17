import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react"

import { matchCommandPrefix } from "./registry"
import type { SlashCommand } from "./types"

export interface UseSlashOptions {
  value: string
  setValue: (value: string) => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
  enabled?: boolean
}

/**
 * Autocomplete for leading `/command` tokens, modelled on the `@`-mention
 * typeahead (`use-mentions`). The menu is open only while the command *name* is
 * being typed — a bare `/` or `/pl` — and closes once a space is typed (the
 * command is chosen and the rest is its arguments). Selecting a row rewrites the
 * input to `/<name> ` and restores focus. It reads the command registry, so it
 * has no hard-coded command names.
 */
export function useSlash({
  value,
  setValue,
  textareaRef,
  enabled = true,
}: UseSlashOptions) {
  const [caret, setCaret] = useState(0)
  const [activeIndex, setActiveIndex] = useState(0)
  const [dismissed, setDismissed] = useState(false)

  const refresh = useCallback(() => {
    setCaret(textareaRef.current?.selectionStart ?? 0)
  }, [textareaRef])

  // Active only when the whole input is a leading slash token with no space yet
  // and the caret sits inside it — i.e. the user is still naming the command.
  const query = useMemo<string | null>(() => {
    if (!enabled) return null
    const m = value.match(/^\/([a-zA-Z][\w-]*)?$/)
    if (!m) return null
    if (caret > value.length) return null
    return m[1] ?? ""
  }, [enabled, value, caret])

  const rows = useMemo<SlashCommand[]>(
    () => (query === null ? [] : matchCommandPrefix(query)),
    [query]
  )

  // Reset transient state when the query changes.
  useEffect(() => {
    setActiveIndex(0)
    setDismissed(false)
  }, [query])

  const open = query !== null && !dismissed && rows.length > 0
  const clampedIndex = rows.length ? Math.min(activeIndex, rows.length - 1) : 0

  const select = useCallback(
    (command: SlashCommand) => {
      const next = `/${command.name} `
      setValue(next)
      const pos = next.length
      setCaret(pos)
      requestAnimationFrame(() => {
        const el = textareaRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(pos, pos)
      })
    },
    [setValue, textareaRef]
  )

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
          select(rows[clampedIndex])
          return true
        case "Escape":
          e.preventDefault()
          setDismissed(true)
          return true
        default:
          return false
      }
    },
    [open, rows, clampedIndex, select]
  )

  return {
    open,
    rows,
    activeIndex: clampedIndex,
    setActiveIndex,
    select,
    onKeyDown,
    refresh,
  }
}
