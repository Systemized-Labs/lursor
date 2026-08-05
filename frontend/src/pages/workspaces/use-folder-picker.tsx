import { useCallback, useState } from "react"
import { toast } from "sonner"

import { useServerInfo } from "@/api/fs"
import { workspacesApi } from "@/api/workspaces"

import { RemoteFolderBrowser } from "./remote-folder-browser"

/**
 * "Choose a folder", whichever way this backend can do it.
 *
 * Two mechanisms, one call: a backend on your own machine opens the real OS dialog
 * (`POST /workspaces/pick-folder` shells out to `osascript`/`zenity`), and a headless
 * one browses its filesystem over the API instead. The branch is the backend's own
 * `can_pick_folder`, so it also covers a Linux desktop with no picker installed —
 * which used to be a 501 and a dead end.
 *
 * A hook returning an element rather than a button component, because the two call
 * sites (the workspace dialog and the first-run walkthrough) style their triggers
 * completely differently and only agree on the behaviour behind them.
 *
 * @param onPick Receives the chosen absolute path on the backend host.
 */
export function useFolderPicker(onPick: (path: string) => void) {
  const { data: serverInfo } = useServerInfo()
  const [browsing, setBrowsing] = useState(false)
  const [remoteOpen, setRemoteOpen] = useState(false)

  const browse = useCallback(async () => {
    // Undefined while server-info is still loading: assume the native dialog, which
    // is right for every local backend, and fall back below if it isn't there.
    if (serverInfo && !serverInfo.can_pick_folder) {
      setRemoteOpen(true)
      return
    }

    setBrowsing(true)
    try {
      const { path } = await workspacesApi.pickFolder()
      if (path) onPick(path)
    } catch (err) {
      // 501 is the backend saying it has no picker binary. That is the same
      // situation `can_pick_folder` describes, so rather than surfacing an error,
      // do what we would have done had we known.
      if (
        err &&
        typeof err === "object" &&
        "status" in err &&
        (err as { status: number }).status === 501
      ) {
        setRemoteOpen(true)
        return
      }
      toast.error(
        err instanceof Error ? err.message : "Could not open the folder picker"
      )
    } finally {
      setBrowsing(false)
    }
  }, [serverInfo, onPick])

  const dialog = (
    <RemoteFolderBrowser
      open={remoteOpen}
      onOpenChange={setRemoteOpen}
      onPick={onPick}
    />
  )

  return { browse, browsing, dialog }
}
