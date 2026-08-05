import { useState } from "react"
import type { ReactNode } from "react"
import { toast } from "sonner"

import {
  requestBackendReconnectWatch,
  useBackendUpdateCheck,
  useBackendUpdateLog,
  useBackendUpdateStatus,
  useStartBackendUpdate,
} from "@/api/update"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/responsive-dialog"
import { DotGridLoader } from "@/components/ui/dot-grid-loader"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { DesktopUpdate } from "@/hooks/use-desktop-update"
import { isElectron } from "@/lib/platform"

/**
 * Everything about being out of date, in one place.
 *
 * Two independent halves, because over a remote connection there are two independent
 * things to update: this app, and the backend it is driving. Either can be newer.
 * Against a local backend the second half is absent — the frozen backend inside the
 * app bundle is replaced by the app update itself.
 */

const remoteName =
  (isElectron && window.electron?.connectionName) || "the remote backend"
const isRemote = isElectron && window.electron?.isRemote === true

interface UpdateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  desktop: DesktopUpdate
}

export function UpdateDialog({ open, onOpenChange, desktop }: UpdateDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Updates</DialogTitle>
          <DialogDescription>
            {isRemote
              ? `This app and ${remoteName} are updated separately.`
              : "Lursor updates itself, backend included."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <ClientSection desktop={desktop} />
          {isRemote ? <BackendSection /> : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Row({
  label,
  value,
  hint,
  children,
}: {
  label: string
  value: string
  /** Why the action is unavailable. Its own line, so it can't crowd out the version. */
  hint?: string | null
  children?: ReactNode
}) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">{label}</p>
          {/* Selectable so it can be pasted into an issue, matching about-section. */}
          <p className="select-text text-xs text-muted-foreground tabular-nums">
            {value}
          </p>
        </div>
        {children}
      </div>
      {hint ? <p className="mt-2 text-xs text-warning">{hint}</p> : null}
    </div>
  )
}

function ClientSection({ desktop }: { desktop: DesktopUpdate }) {
  const { state, install, defer, check } = desktop

  const detail = (() => {
    switch (state.phase) {
      case "checking":
        return "Checking for updates…"
      case "available":
        return state.mechanism === "script"
          ? `Version ${state.version} is available.`
          : `Version ${state.version} found — downloading.`
      case "downloading":
        return `Downloading ${state.version}… ${state.percent ?? 0}%`
      case "downloaded":
        return `Version ${state.version} is ready to install.`
      case "error":
        return state.error ?? "The update check failed."
      case "unsupported":
        return state.note ?? "Updates are not available for this build."
      default:
        return "Up to date."
    }
  })()

  return (
    <Row label="This app" value={`Version ${__APP_VERSION__} · ${detail}`}>
      {state.phase === "downloaded" ? (
        <div className="flex shrink-0 gap-2">
          <Button size="sm" variant="outline" onClick={defer}>
            Later
          </Button>
          <Button size="sm" onClick={install}>
            Restart now
          </Button>
        </div>
      ) : state.phase === "available" && state.mechanism === "script" ? (
        <Button size="sm" className="shrink-0" onClick={install}>
          Update now
        </Button>
      ) : state.phase === "downloading" || state.phase === "checking" ? (
        <DotGridLoader size="xs" className="shrink-0 text-muted-foreground" />
      ) : state.phase === "unsupported" ? null : (
        <Button size="sm" variant="outline" className="shrink-0" onClick={check}>
          Check
        </Button>
      )}
    </Row>
  )
}

function BackendSection() {
  const { data: status } = useBackendUpdateStatus()
  const check = useBackendUpdateCheck()
  const start = useStartBackendUpdate()
  const [confirming, setConfirming] = useState(false)

  const job = status?.last_update
  const running = job?.state === "running" || start.isSuccess
  const log = useBackendUpdateLog(running)

  const latest = check.data?.latest
  const detail = (() => {
    if (check.data?.error) return check.data.error
    if (check.data?.update_available) return `Version ${latest} is available.`
    if (check.data) return "Up to date."
    return "Check for a newer release."
  })()

  /**
   * Why there is no Update button, shown whenever there isn't one.
   *
   * This used to be folded into `detail` and lost the moment a check succeeded: the
   * row then read "Version 0.1.7 is available" with no button and no explanation,
   * which reads as a broken button rather than as a host that can't do it. An
   * unexplained absent control is the exact thing `self_update_blocked_reason` exists
   * to prevent, so it gets its own line and does not compete with the version.
   */
  const blocked = status && !status.self_updatable ? status.self_update_blocked_reason : null

  /**
   * Check, and say so.
   *
   * The button needs to acknowledge itself: the result is cached for ten minutes on
   * the backend, so a second press returns in milliseconds and leaves identical text
   * on screen. Without this the button reads as dead when it is in fact working
   * perfectly — the "Checking…" label flickers past far too fast to register.
   */
  const onCheck = async () => {
    const { data } = await check.refetch()
    if (!data) return
    if (data.error) toast.error(data.error)
    else if (data.update_available)
      toast.info(`${remoteName}: version ${data.latest} is available.`)
    else toast.success(`${remoteName} is up to date (${data.current}).`)
  }

  const onConfirm = () => {
    setConfirming(false)
    start.mutate(undefined, {
      onSuccess: () => {
        requestBackendReconnectWatch()
        toast.info(`${remoteName} is updating. It will drop offline briefly.`)
      },
      onError: (err) =>
        toast.error(err instanceof Error ? err.message : "Could not start the update"),
    })
  }

  return (
    <>
      <Row
        label={remoteName}
        value={
          status
            ? `Version ${status.version}${
                status.git?.commit ? ` · ${status.git.commit}` : ""
              } · ${detail}`
            : detail
        }
        hint={blocked}
      >
        <div className="flex shrink-0 gap-2">
          {running ? (
            <DotGridLoader size="xs" className="text-muted-foreground" />
          ) : (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={check.isFetching}
                onClick={() => void onCheck()}
              >
                {check.isFetching ? "Checking…" : "Check"}
              </Button>
              {status?.self_updatable ? (
                <Button size="sm" onClick={() => setConfirming(true)}>
                  Update
                </Button>
              ) : null}
            </>
          )}
        </div>
      </Row>

      {/* The log is the durable record across the restart — the process that served
          the request is gone by the time this matters, so it is read from a file on
          the host rather than from anything in memory. */}
      {running || log.data?.log ? (
        <ScrollArea className="h-56 rounded-md border border-border bg-muted/30">
          {log.data?.log ? (
            <pre className="whitespace-pre-wrap p-3 font-mono text-xs text-foreground">
              {log.data.log.trim()}
            </pre>
          ) : (
            <p className="p-3 text-sm text-muted-foreground">Starting update…</p>
          )}
        </ScrollArea>
      ) : null}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Update ${remoteName}?`}
        description={
          <>
            It will fetch the latest release, sync dependencies and restart. That stops
            any running agents and drops this connection for a minute or two —
            dependency syncing is the slow part. Your database, workspaces and token are
            untouched.
          </>
        }
        confirmLabel="Update backend"
        loading={start.isPending}
        onConfirm={onConfirm}
      />
    </>
  )
}
