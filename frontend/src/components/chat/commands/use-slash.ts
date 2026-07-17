import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react"

import { matchCommandPrefix } from "./registry"
import { findActiveSlash, type SlashCommand } from "./types"

export interface UseSlashOptions {
  value: string
  setValue: (value: string) => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
  enabled?: boolean
}

/**
 * Autocomplete for `/command` tokens, modelled on the `@`-mention typeahead
 * (`use-mentions`). The menu triggers wherever the caret sits on a slash token
 * at a word boundary — not only when the whole input is `/command` — and closes
 * once a space is typed (the command is chosen and the rest is its arguments).
 * Selecting a row rewrites just that token to `/<name> ` and restores focus. It
 * reads the command registry, so it has no hard-coded command names.
 *
 * Note the parser (`parseSlashCommand`) still only *honors* a command at the
 * start of the message, since a command governs the whole turn; the menu firing
 * mid-text is a convenience, and a token inserted there sends as plain text.
 */
export function useSlash({
  value,
  setValue,
  textareaRef,
  enabled = true,
}: UseSlashOptions) {
  const [caret, setCaret] = useState(0)
  const [activeIndex, setActiveIndex] = useState(0)
  const [dismissedStart, setDismissedStart] = useState<number | null>(null)

  const refresh = useCallback(() => {
    setCaret(textareaRef.current?.selectionStart ?? 0)
  }, [textareaRef])

  // The slash token under the caret, wherever it is in the input.
  const active = useMemo(
    () => (enabled ? findActiveSlash(value, caret) : null),
    [enabled, value, caret]
  )

  const rows = useMemo<SlashCommand[]>(
    () => (active === null ? [] : matchCommandPrefix(active.query)),
    [active]
  )

  // Reset transient state when the token changes (position or query).
  useEffect(() => {
    setActiveIndex(0)
    setDismissedStart(null)
  }, [active?.start, active?.query])

  const open =
    active !== null && active.start !== dismissedStart && rows.length > 0
  const clampedIndex = rows.length ? Math.min(activeIndex, rows.length - 1) : 0

  const select = useCallback(
    (command: SlashCommand) => {
      if (!active) return
      const token = `/${command.name} `
      const next = value.slice(0, active.start) + token + value.slice(active.end)
      const pos = active.start + token.length
      setValue(next)
      setCaret(pos)
      requestAnimationFrame(() => {
        const el = textareaRef.current
        if (!el) return
        el.focus()
        el.setSelectionRange(pos, pos)
      })
    },
    [active, value, setValue, textareaRef]
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
          if (active) setDismissedStart(active.start)
          return true
        default:
          return false
      }
    },
    [open, rows, clampedIndex, select, active]
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
