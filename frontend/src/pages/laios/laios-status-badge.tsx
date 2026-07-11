import { useQueryClient } from "@tanstack/react-query"
import { AlertCircle, CheckCircle2, Loader2, RefreshCw } from "lucide-react"

import { laiosKeys, useLaiosStatus } from "@/api/laios"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

/**
 * Live reachability + auth status of a laios daemon connection. Shown next to
 * the connection selector so an unreachable or unauthorized daemon (possibly
 * remote) is visible rather than surfacing as opaque request failures.
 */
export function LaiosStatusBadge({ connectionId }: { connectionId: string }) {
  const qc = useQueryClient()
  const { data, isLoading, isError, isFetching } = useLaiosStatus(connectionId)

  function recheck() {
    qc.invalidateQueries({ queryKey: laiosKeys.status(connectionId) })
  }

  const checking = isLoading || isFetching
  const errorText = isError
    ? "Status check failed."
    : data?.status === "error"
      ? (data.error ?? "Something went wrong.")
      : null
  const healthy = !errorText && data?.status === "ok"

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        {checking && !data ? (
          <Badge variant="secondary" className="gap-1 font-normal">
            <Loader2 className="h-3 w-3 animate-spin" />
            Checking…
          </Badge>
        ) : healthy ? (
          <Badge variant="success" className="gap-1 font-normal">
            <CheckCircle2 className="h-3 w-3" />
            Connected
            {data?.version ? ` · v${data.version}` : ""}
            {data?.role ? ` · ${data.role}` : ""}
          </Badge>
        ) : (
          <Badge variant="destructive" className="gap-1 font-normal">
            <AlertCircle className="h-3 w-3" />
            {data?.reachable ? "Unauthorized" : "Unreachable"}
          </Badge>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={recheck}
          disabled={checking}
          aria-label="Re-check daemon status"
        >
          <RefreshCw className="h-3 w-3" />
        </Button>
      </div>
      {!checking && errorText ? (
        <p className="text-xs text-destructive">{errorText}</p>
      ) : null}
    </div>
  )
}
