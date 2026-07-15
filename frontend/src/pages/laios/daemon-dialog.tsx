import { ArrowCircleUp, ArrowsClockwise, GitCommit } from "@phosphor-icons/react"
import { useState } from "react"
import { toast } from "sonner"

import {
  useDaemonRestart,
  useDaemonUpdate,
  useLaiosDaemonVersion,
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
      toast.success("Restarting daemon — it will drop offline briefly")
      setConfirmRestart(false)
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
