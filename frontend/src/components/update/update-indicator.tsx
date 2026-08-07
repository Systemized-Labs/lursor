import { useEffect, useState } from "react"
import { ArrowCircleUp } from "@phosphor-icons/react"
import { toast } from "sonner"

import { useBackendReconnect, useBackendUpdateStatus } from "@/api/update"
import { useServerInfo } from "@/api/fs"
import { UpdateDialog } from "@/components/update/update-dialog"
import { DotGridLoader } from "@/components/ui/dot-grid-loader"
import { shouldToastFor, useDesktopUpdate } from "@/hooks/use-desktop-update"
import { isElectron } from "@/lib/platform"
import { cn } from "@/lib/utils"

/**
 * One glyph in the window bar for "something here is out of date".
 *
 * This is the half of the notification that does *not* go away. The toast beside it is
 * dismissible and per-version; this stays lit for as long as the update exists, which
 * is the whole reason it is a separate surface — the native dialog it replaced was
 * destroyed on dismissal, and an update nobody accepted then sat invisible until the
 * next six-hourly poll.
 *
 * It lives in `window-bar` rather than in `ConnectionStatus`: an update is about this
 * client and the backend it drives, not about which connection is selected, and the two
 * badges appear and disappear on entirely different schedules.
 *
 * Skew is reported, never enforced. A 0.1.7 client against a 0.1.6 backend keeps
 * working; the point is to explain a confusing symptom, not to gate the app.
 */

const isRemote = isElectron && window.electron?.isRemote === true
const remoteName = (isElectron && window.electron?.connectionName) || "the backend"

export function UpdateIndicator({ className }: { className?: string }) {
  const desktop = useDesktopUpdate()
  const [open, setOpen] = useState(false)
  // Owned here, because this is mounted on every route: closing the dialog the update
  // was started from must not abandon the poll. Triggered via the module-scope signal
  // in `api/update.ts`, so Settings can start one too.
  const { reconnecting } = useBackendReconnect()

  // Only meaningful for a remote backend: a local one is replaced by the client
  // update, so its version cannot disagree with ours.
  const { data: serverInfo } = useServerInfo()
  useBackendUpdateStatus(isRemote)

  const skewed =
    isRemote && Boolean(serverInfo?.version) && serverInfo?.version !== __APP_VERSION__

  const { state, actionable, install, dismiss } = desktop

  // Toast once per version. Fired here because this component is mounted on every
  // route, so the announcement does not depend on which screen you happened to be on
  // when the download finished.
  useEffect(() => {
    if (!actionable || !state.version) return
    if (!shouldToastFor(state.version)) return

    const ready = state.phase === "downloaded"
    toast(`Lursor ${state.version} is available`, {
      id: `update-${state.version}`,
      duration: Infinity,
      description: ready
        ? isRemote
          ? `Restarting will disconnect you from ${remoteName} and stop any running agents.`
          : "Restarting takes a few seconds and stops any running agents."
        : (state.note ?? undefined),
      action: {
        label: ready ? "Restart" : "Update",
        onClick: install,
      },
      onDismiss: dismiss,
    })
  }, [actionable, state.version, state.phase, state.note, install, dismiss])

  const clientPending =
    state.phase === "available" ||
    state.phase === "downloaded" ||
    state.phase === "downloading"

  if (!clientPending && !skewed && !reconnecting) return null

  const tone = reconnecting
    ? "text-muted-foreground"
    : state.phase === "downloaded"
      ? "text-success"
      : skewed && !clientPending
        ? "text-warning"
        : "text-muted-foreground"

  const title = reconnecting
    ? `Waiting for ${remoteName} to come back…`
    : state.phase === "downloaded"
      ? `Lursor ${state.version} is ready to install`
      : state.phase === "downloading"
        ? `Downloading ${state.version}… ${state.percent ?? 0}%`
        : clientPending
          ? `Lursor ${state.version} is available`
          : `This app is ${__APP_VERSION__}, ${remoteName} is ${serverInfo?.version}`

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Updates"
        title={title}
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-sidebar-accent",
          // Frameless macOS: the bar is a drag region, so every button opts out.
          "[-webkit-app-region:no-drag]",
          tone,
          className
        )}
      >
        {reconnecting ? (
          <DotGridLoader size="2xs" />
        ) : (
          <ArrowCircleUp className="h-4 w-4" />
        )}
      </button>

      <UpdateDialog open={open} onOpenChange={setOpen} desktop={desktop} />
    </>
  )
}
