import { useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"

import { laiosKeys, useLaiosUpdateLog } from "@/api/laios"
import { DotGridLoader } from "@/components/ui/dot-grid-loader"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/responsive-dialog"
import { ScrollArea } from "@/components/ui/scroll-area"

interface UpdateLogDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  connectionId: string
  /** The log name returned by POST /daemon/update, or undefined before start. */
  log: string | undefined
}

/**
 * Live tail of a daemon self-update (git ff + rebuild + restart). Polls while
 * the daemon reports the log active and stops once it goes quiet. The daemon
 * restarts partway through, so the log (on disk) is the durable record across
 * the gap; when it settles we refresh the version so the badge shows the new sha.
 */
export function UpdateLogDialog({
  open,
  onOpenChange,
  connectionId,
  log,
}: UpdateLogDialogProps) {
  const qc = useQueryClient()
  const { data, isError, error, isFetching } = useLaiosUpdateLog(
    open ? connectionId : undefined,
    open ? log : undefined
  )

  const active = data?.active ?? true
  const logs = data?.logs?.trim()

  // Once the update stops writing, the daemon has (re)started on the new build —
  // refresh version + reachability so the UI reflects it without a manual poke.
  useEffect(() => {
    if (open && data && !data.active) {
      qc.invalidateQueries({ queryKey: laiosKeys.daemonVersion(connectionId) })
      qc.invalidateQueries({ queryKey: laiosKeys.status(connectionId) })
    }
  }, [open, data, qc, connectionId])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-hidden">
        <DialogHeader>
          <div className="flex items-center justify-between gap-2">
            <div>
              <DialogTitle>Updating daemon</DialogTitle>
              <DialogDescription>
                Fast-forwarding, rebuilding, and restarting. The daemon will drop
                offline briefly as it restarts.
              </DialogDescription>
            </div>
            {active ? (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <DotGridLoader size="xs" />
                working
              </div>
            ) : (
              <span className="text-xs text-muted-foreground">done</span>
            )}
          </div>
        </DialogHeader>

        <ScrollArea className="h-[60vh] rounded-md border border-border bg-muted/30">
          {isError ? (
            <p className="p-4 text-sm text-destructive">
              {error instanceof Error ? error.message : "Failed to read update log"}
            </p>
          ) : logs ? (
            <pre className="whitespace-pre-wrap p-4 font-mono text-xs text-foreground">
              {logs}
            </pre>
          ) : isFetching ? (
            <p className="p-4 text-sm text-muted-foreground">Starting update…</p>
          ) : (
            <p className="p-4 text-sm text-muted-foreground">No output yet.</p>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
