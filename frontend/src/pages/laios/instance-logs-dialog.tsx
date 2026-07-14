import { useQuery } from "@tanstack/react-query"
import { ArrowsClockwise } from "@phosphor-icons/react"

import { laiosApi, laiosKeys } from "@/api/laios"
import type { LaiosInstance } from "@/api/types"
import { Button } from "@/components/ui/button"
import { DotGridLoader } from "@/components/ui/dot-grid-loader"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/responsive-dialog"
import { ScrollArea } from "@/components/ui/scroll-area"

interface InstanceLogsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  connectionId: string
  instance: LaiosInstance | undefined
}

/**
 * Engine logs for one instance. The daemon exposes logs as a one-shot pull (no
 * stream), so this fetches on open with a manual refresh button.
 */
export function InstanceLogsDialog({
  open,
  onOpenChange,
  connectionId,
  instance,
}: InstanceLogsDialogProps) {
  const enabled = open && Boolean(instance)
  const { data, isFetching, isError, error, refetch } = useQuery({
    queryKey: instance
      ? laiosKeys.logs(connectionId, instance.id)
      : laiosKeys.all,
    queryFn: ({ signal }) =>
      laiosApi.logs(connectionId, instance!.id, 300, signal),
    enabled,
    refetchOnWindowFocus: false,
    retry: false,
  })

  const logs = data?.logs?.trim()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-hidden">
        <DialogHeader>
          <div className="flex items-center justify-between gap-2">
            <div>
              <DialogTitle>Logs · {instance?.served_name}</DialogTitle>
              <DialogDescription>
                Last 300 lines from the engine. Not live — refresh to update.
              </DialogDescription>
            </div>
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
              Refresh
            </Button>
          </div>
        </DialogHeader>

        <ScrollArea className="h-[60vh] rounded-md border border-border bg-muted/30">
          {isError ? (
            <p className="p-4 text-sm text-destructive">
              {error instanceof Error ? error.message : "Failed to load logs"}
            </p>
          ) : isFetching && !data ? (
            <p className="p-4 text-sm text-muted-foreground">Loading logs…</p>
          ) : logs ? (
            <pre className="whitespace-pre-wrap p-4 font-mono text-xs text-foreground">
              {logs}
            </pre>
          ) : (
            <p className="p-4 text-sm text-muted-foreground">No logs yet.</p>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
