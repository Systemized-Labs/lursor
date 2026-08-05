import { useCallback, useEffect, useState } from "react"

import { readStored, writeStored } from "@/hooks/use-stored"
import { isElectron } from "@/lib/platform"

/**
 * The desktop client's own update state, mirrored from the Electron main process.
 *
 * The offer used to be a native `dialog.showMessageBox` in `electron/main.cjs`. The
 * problem with a modal is that dismissing it destroys it: the update was then
 * invisible until the next six-hourly poll, and since `autoInstallOnAppQuit` stays
 * false nothing happened in the meantime either. So the state comes here instead and
 * gets two surfaces with deliberately different lifetimes — a toast you can dismiss,
 * and an indicator you cannot.
 *
 * Nothing to mirror in a browser; `phase` stays `unsupported` there.
 */

const DISMISSED_KEY = "lursor:update-dismissed"

const IDLE: DesktopUpdateState = {
  phase: isElectron ? "idle" : "unsupported",
  version: null,
  percent: null,
  error: null,
  mechanism: "none",
  note: isElectron ? null : "Updates are managed outside the browser.",
}

export interface DesktopUpdate {
  state: DesktopUpdateState
  /** True when there is a version the user has not dismissed a toast for. */
  actionable: boolean
  /** Whether the *toast* for the current version has been dismissed. */
  dismissed: boolean
  dismiss: () => void
  install: () => void
  defer: () => void
  check: () => void
}

export function useDesktopUpdate(): DesktopUpdate {
  const [state, setState] = useState<DesktopUpdateState>(IDLE)
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(() =>
    readStored(DISMISSED_KEY)
  )

  useEffect(() => {
    const bridge = window.electron
    if (!bridge?.onUpdateState) return
    // Subscribe before the initial read, so a transition landing between the two is
    // not lost.
    const unsubscribe = bridge.onUpdateState(setState)
    void bridge.getUpdateState().then(setState)
    return unsubscribe
  }, [])

  const version = state.version

  const dismiss = useCallback(() => {
    if (!version) return
    writeStored(DISMISSED_KEY, version)
    setDismissedVersion(version)
  }, [version])

  const install = useCallback(() => {
    void window.electron?.installUpdate?.()
  }, [])

  const defer = useCallback(() => {
    void window.electron?.deferUpdate?.()
    dismiss()
  }, [dismiss])

  const check = useCallback(() => {
    void window.electron?.checkForUpdates?.()
  }, [])

  const offering = state.phase === "available" || state.phase === "downloaded"
  // Storing the dismissed *version* rather than a boolean is what makes this work:
  // dismissing 0.1.8 must not silence 0.1.9.
  const dismissed = Boolean(version) && dismissedVersion === version

  return {
    state,
    actionable: offering && !dismissed,
    dismissed,
    dismiss,
    install,
    defer,
    check,
  }
}

/**
 * The version a toast has already been shown for, shared across mounts.
 *
 * Module-scope rather than a ref, because the toast is fired from the indicator and
 * the indicator remounts on route changes in some layouts — a per-mount ref would let
 * the same version toast again each time.
 */
let lastToastedVersion: string | null = null

export function shouldToastFor(version: string | null): boolean {
  if (!version || lastToastedVersion === version) return false
  lastToastedVersion = version
  return true
}
