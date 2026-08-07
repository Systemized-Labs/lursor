import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { CloudSlash, Cloud, Desktop, Warning } from "@phosphor-icons/react"

import { api, subscribeUnauthorized } from "@/api/client"
import { isElectron } from "@/lib/platform"
import { cn } from "@/lib/utils"

/**
 * How often to check a remote backend is still there. Cheap (`/api/health` is a
 * two-key JSON response), and 15s is short enough that a dropped link is noticed
 * before you have typed a whole message into a void.
 */
const HEALTHY_INTERVAL_MS = 15_000
/** Once it's down, look more often — this is also how recovery is detected. */
const UNHEALTHY_INTERVAL_MS = 4_000

/**
 * True when the desktop app is driving a backend on another machine.
 *
 * Read once at module scope, like the API base it belongs to: switching connections
 * reloads the window.
 */
const isRemote = isElectron && window.electron?.isRemote === true
const connectionName =
  (isElectron && window.electron?.connectionName) || (isRemote ? "the backend" : "This machine")

/**
 * Connection health for a remote backend.
 *
 * Only meaningful for one: a local backend is a child process on loopback, and if it
 * has gone the app has bigger problems than an indicator. Kept out of the query
 * cache's normal invalidation paths by its own key.
 */
function useRemoteHealth() {
  return useQuery({
    queryKey: ["connection", "health"],
    queryFn: ({ signal }) => api.get<{ status: string }>("/health", signal),
    enabled: isRemote,
    // A failed poll is the signal, not an error to retry into the ground.
    retry: false,
    refetchInterval: (query) =>
      query.state.status === "error" ? UNHEALTHY_INTERVAL_MS : HEALTHY_INTERVAL_MS,
    // Keep polling while the window is in the background: a run that finishes while
    // you are in another app should not surface as a stale "reconnecting".
    refetchIntervalInBackground: true,
  })
}

/**
 * What machine you are driving, and whether it is still answering.
 *
 * Always present in the desktop app, local backend included: the badge is the only
 * way into the connection picker, so hiding it in local mode made switching *to* a
 * remote backend a one-way door you could only walk through from the other side.
 * Health states below are still remote-only — a local backend is a child process on
 * loopback, and "reconnecting" is not a state it has.
 *
 * Still null outside Electron: a browser tab is served by the backend it is talking
 * to, and there is no picker to open.
 */
export function ConnectionStatus() {
  const { isError, isSuccess } = useRemoteHealth()
  const [rejected, setRejected] = useState(false)

  // A rejected token is a different failure from an unreachable host, and only one
  // of them is fixable by waiting. Any request in the app can discover it, so the
  // signal comes from the API client rather than from the health poll.
  useEffect(() => subscribeUnauthorized(() => setRejected(true)), [])

  if (!isElectron) return null

  const switchConnection = () => void window.electron?.switchConnection?.()

  if (!isRemote) {
    return (
      <button
        type="button"
        onClick={switchConnection}
        title={`Running on ${connectionName}. Click to switch connection.`}
        className={cn(
          badgeClass,
          "text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        )}
      >
        <Desktop className="size-3.5" />
        <span className="truncate">{connectionName}</span>
      </button>
    )
  }

  if (rejected) {
    return (
      <button
        type="button"
        onClick={switchConnection}
        title="The backend rejected this connection's token. Choose a connection."
        className={cn(badgeClass, "text-destructive hover:bg-sidebar-accent")}
      >
        <Warning className="size-3.5" />
        <span className="truncate">Token rejected</span>
      </button>
    )
  }

  if (isError) {
    return (
      <span
        title={`Cannot reach ${connectionName}. Retrying every few seconds.`}
        className={cn(badgeClass, "text-warning")}
      >
        <CloudSlash className="size-3.5" />
        <span className="truncate">Reconnecting to {connectionName}…</span>
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={switchConnection}
      title={`Connected to ${connectionName}. Click to switch connection.`}
      className={cn(
        badgeClass,
        "text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      )}
    >
      <Cloud className={cn("size-3.5", isSuccess && "opacity-70")} />
      <span className="truncate">{connectionName}</span>
    </button>
  )
}

/** `no-drag` so it stays clickable inside the frameless title-bar drag region. */
const badgeClass =
  "flex min-w-0 max-w-[16rem] items-center gap-1.5 rounded-md px-2 py-1 text-xs [-webkit-app-region:no-drag]"
