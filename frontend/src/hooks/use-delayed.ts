import { useEffect, useState } from "react"

/**
 * How long a local operation may take before it is worth admitting to.
 *
 * Reading a directory or searching a workspace answers in a few milliseconds, so
 * a skeleton or a dimmed list drawn the instant one starts appears and vanishes
 * within a blink — a flicker on every keystroke, and a worse one when the result
 * is empty and the rows collapse to nothing. Past this window the wait is real and
 * saying so is the honest thing.
 */
export const LOADING_DELAY_MS = 200

/** True once `active` has stayed true for `delayMs`; false the moment it clears. */
export function useDelayed(active: boolean, delayMs = LOADING_DELAY_MS): boolean {
  const [elapsed, setElapsed] = useState(false)

  useEffect(() => {
    if (!active) {
      setElapsed(false)
      return
    }
    const timer = setTimeout(() => setElapsed(true), delayMs)
    return () => clearTimeout(timer)
  }, [active, delayMs])

  return active && elapsed
}
