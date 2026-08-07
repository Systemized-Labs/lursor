import { useCallback, useEffect, useSyncExternalStore } from "react"

/**
 * Open state and the global chord for the Assistant overlay.
 *
 * ⌘⇧A (Ctrl+Shift+A elsewhere). Bound on `window` rather than on a container,
 * because "reachable from anywhere" is the point — a workspace chat, the
 * analytics pane and the settings dialog all have to answer to it. Like every
 * other chord in the app the handler lives with the feature rather than in a
 * registry; `lib/shortcuts.ts` documents it.
 *
 * The state is module-level rather than `useState` in the shell, so the sidebar
 * row can open the same overlay the shell renders without threading a callback
 * through `AppSidebar` and `SessionsPane` — two components that have no other
 * reason to know the Assistant exists. Deliberately not a request channel: those
 * carry a *payload* to a workspace-scoped surface (`open-file`, `open-thread`),
 * and this is one boolean with no addressee.
 *
 * Typing is deliberately not excluded from the chord: unlike a bare letter, a
 * modifier chord in a textarea is unambiguous, and having to leave the composer
 * to summon the Assistant would defeat the point of it being global.
 */

let isOpen = false
const listeners = new Set<() => void>()

function setOpen(next: boolean): void {
  if (isOpen === next) return
  isOpen = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const getSnapshot = () => isOpen

export function useAssistantOverlay() {
  const open = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const toggle = useCallback(() => setOpen(!isOpen), [])
  return { open, setOpen, toggle }
}

/**
 * Binds the chord. Mounted once, by the shell — a per-consumer listener would
 * toggle the overlay once per mounted consumer and net out to nothing.
 */
export function useAssistantHotkey(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return
      // `event.key` is unreliable with Shift held (it arrives upper- or
      // lower-cased depending on layout); `code` is the physical key.
      if (event.code !== "KeyA") return
      event.preventDefault()
      setOpen(!isOpen)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])
}
