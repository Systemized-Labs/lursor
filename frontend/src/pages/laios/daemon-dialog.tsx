import {
  ArrowCircleUp,
  ArrowsClockwise,
  CheckCircle,
  GitCommit,
  WarningCircle,
} from "@phosphor-icons/react"
import { useState } from "react"
import { toast } from "sonner"

import {
  useDaemonRestart,
  useDaemonUpdate,
  useLaiosDaemonVersion,
  useLaiosDoctor,
  useLaiosUpdateCheck,
} from "@/api/laios"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/responsive-dialog"
import { DotGridLoader } from "@/components/ui/dot-grid-loader"
import { UpdateLogDialog } from "./update-log-dialog"

interface DaemonDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  connectionId: string
  /** Called after a restart is accepted; the parent owns the reconnect UI. */
  onRestartInitiated: () => void
}

/**
 * Manage the daemon behind a connection: see the running build, check whether
 * the checkout is behind its branch, and restart or update (git ff + rebuild +
 * restart) in place. All logic lives in the daemon; this only calls the proxied
 * endpoints. Queries are gated on `open` so nothing polls while the dialog is
 * closed.
 */
export function DaemonDialog({
  open,
  onOpenChange,
  connectionId,
  onRestartInitiated,
}: DaemonDialogProps) {
  const scoped = open ? connectionId : undefined
  const { data: version } = useLaiosDaemonVersion(scoped)
  const check = useLaiosUpdateCheck(scoped)
  const restart = useDaemonRestart(connectionId)
  const update = useDaemonUpdate(connectionId)

  const [confirmRestart, setConfirmRestart] = useState(false)
  const [confirmUpdate, setConfirmUpdate] = useState(false)
  const [updateLog, setUpdateLog] = useState<string | undefined>()
  const [logOpen, setLogOpen] = useState(false)

  // The daemon can't update without a configured checkout; disable + explain.
  const canUpdate = Boolean(version?.repo_dir)

  // Update-availability, from the on-demand check (not the cheap version poll).
  // Distinguish "couldn't check" (checked=false, e.g. no repo_dir configured)
  // from a real git failure (checked=true + error) so the former reads as a
  // muted, actionable hint rather than a scary red error.
  const checkData = check.data?.update
  const behind = checkData?.behind_by
  const notConfigured = checkData != null && checkData.checked === false
  const checkError = checkData?.checked ? checkData.error : undefined

  async function doRestart() {
    try {
      await restart.mutateAsync()
      setConfirmRestart(false)
      // Hand off to the parent: close this dialog and let it own the
      // "restarting…" indicator while the daemon cycles.
      onOpenChange(false)
      onRestartInitiated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to restart daemon")
    }
  }

  async function doUpdate() {
    try {
      const res = await update.mutateAsync()
      setUpdateLog(res.log)
      setLogOpen(true)
      setConfirmUpdate(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start update")
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Daemon</DialogTitle>
            <DialogDescription>
              Manage the LAIOS control-plane daemon for this connection — check
              for updates, restart, or update it in place.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Running build. */}
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 p-3">
              {version ? (
                <>
                  <span className="text-sm font-medium text-foreground">
                    v{version.version}
                  </span>
                  <span className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
                    <GitCommit className="h-3.5 w-3.5" />
                    {version.git_sha}
                  </span>
                  <Badge variant="outline" className="font-normal">
                    {version.management_mode}
                  </Badge>
                  <div className="ml-auto">
                    {check.isFetching ? (
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <DotGridLoader size="2xs" />
                        checking…
                      </span>
                    ) : notConfigured ? (
                      <span
                        className="text-xs text-muted-foreground"
                        title={checkData?.error ?? undefined}
                      >
                        update not configured
                      </span>
                    ) : checkError ? (
                      <span
                        className="text-xs text-destructive"
                        title={checkError}
                      >
                        check failed
                      </span>
                    ) : behind != null ? (
                      behind > 0 ? (
                        <Badge variant="secondary" className="gap-1 font-normal">
                          <ArrowCircleUp className="h-3 w-3" />
                          {behind} behind
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          up to date
                        </span>
                      )
                    ) : null}
                  </div>
                </>
              ) : (
                <span className="text-sm text-muted-foreground">
                  version unavailable
                </span>
              )}
            </div>

            {/* Actions. */}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => check.refetch()}
                disabled={check.isFetching}
              >
                {check.isFetching ? (
                  <DotGridLoader size="xs" />
                ) : (
                  <ArrowsClockwise className="h-4 w-4" />
                )}
                Check for updates
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmRestart(true)}
                disabled={restart.isPending}
              >
                {restart.isPending ? (
                  <DotGridLoader size="xs" />
                ) : (
                  <ArrowsClockwise className="h-4 w-4" />
                )}
                Restart
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmUpdate(true)}
                disabled={!canUpdate || update.isPending}
              >
                <ArrowCircleUp className="h-4 w-4" />
                Update
              </Button>
            </div>

            {!canUpdate ? (
              <p className="text-xs text-muted-foreground">
                In-place update is disabled — set{" "}
                <span className="font-mono">[maintenance] repo_dir</span> in
                laios.toml to enable it.
              </p>
            ) : null}

            <DiagnosticsSection connectionId={scoped} />
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmRestart}
        onOpenChange={setConfirmRestart}
        title="Restart daemon"
        description="Restart the LAIOS control plane. Running models keep serving, but the daemon (and this UI's connection to it) will be briefly unavailable."
        confirmLabel="Restart"
        destructive
        loading={restart.isPending}
        onConfirm={doRestart}
      />

      <ConfirmDialog
        open={confirmUpdate}
        onOpenChange={setConfirmUpdate}
        title="Update daemon"
        description="Fast-forward the checkout to its latest branch, rebuild the release binaries, and restart the daemon. This can take several minutes and the daemon will restart when it finishes. A dirty checkout is refused."
        confirmLabel="Update"
        destructive
        loading={update.isPending}
        onConfirm={doUpdate}
      />

      <UpdateLogDialog
        open={logOpen}
        onOpenChange={setLogOpen}
        connectionId={connectionId}
        log={updateLog}
      />
    </>
  )
}

// Daemon self-diagnostics: the `/v1/doctor` checks (GPU/driver/gateway/etc.)
// collapsed by default so the dialog stays focused on version + lifecycle, and
// only fetched (via the gated hook) when the dialog is open.
function DiagnosticsSection({ connectionId }: { connectionId: string | undefined }) {
  const { data, isLoading, isError, error, refetch, isFetching } =
    useLaiosDoctor(connectionId)
  const [open, setOpen] = useState(false)

  const failing = data?.checks.filter((c) => !c.ok).length ?? 0

  return (
    <div className="rounded-lg border border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium text-foreground transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span>Diagnostics</span>
        {data ? (
          data.ok ? (
            <Badge variant="success" className="gap-1 font-normal">
              <CheckCircle className="h-3 w-3" />
              healthy
            </Badge>
          ) : (
            <Badge variant="destructive" className="gap-1 font-normal">
              <WarningCircle className="h-3 w-3" />
              {failing} issue{failing === 1 ? "" : "s"}
            </Badge>
          )
        ) : null}
      </button>

      {open ? (
        <div className="space-y-2 border-t border-border p-3">
          {isLoading ? (
            <p className="text-xs text-muted-foreground">Running checks…</p>
          ) : isError ? (
            <p className="text-xs text-destructive">
              {error instanceof Error ? error.message : "Diagnostics failed"}
            </p>
          ) : data ? (
            <>
              <ul className="space-y-1.5">
                {data.checks.map((c) => (
                  <li key={c.name} className="flex items-start gap-2 text-xs">
                    {c.ok ? (
                      <CheckCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                    ) : (
                      <WarningCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                    )}
                    <span className="min-w-0">
                      <span className="font-medium text-foreground">{c.name}</span>
                      {c.detail ? (
                        <span className="text-muted-foreground"> — {c.detail}</span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
              <Button
                variant="outline"
                size="sm"
                onClick={() => refetch()}
                disabled={isFetching}
              >
                {isFetching ? (
                  <DotGridLoader size="xs" />
                ) : (
                  <ArrowsClockwise className="h-4 w-4" />
                )}
                Re-run
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
