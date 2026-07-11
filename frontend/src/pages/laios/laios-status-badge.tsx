import { Loader2 } from "lucide-react"

import { useLaiosStatus } from "@/api/laios"
import { cn } from "@/lib/utils"

/**
 * Live reachability + auth status of a laios daemon connection. Rendered as a
 * quiet inline indicator (dot + label) so it reads as connection metadata,
 * while still surfacing an unreachable/unauthorized daemon (possibly remote)
 * instead of letting it fail opaquely. Status is polled in the background.
 */
export function LaiosStatusBadge({ connectionId }: { connectionId: string }) {
  const { data, isLoading, isError, isFetching } = useLaiosStatus(connectionId)

  const checking = isLoading || isFetching
  const errorText = isError
    ? "Status check failed."
    : data?.status === "error"
      ? (data.error ?? "Something went wrong.")
      : null
  const healthy = !errorText && data?.status === "ok"

  // reachable-but-not-ok is a soft warning (e.g. bad key); anything else down.
  const tone = healthy
    ? "bg-success"
    : errorText && data?.reachable
      ? "bg-warning"
      : "bg-destructive"

  const label =
    checking && !data
      ? "Checking…"
      : healthy
        ? `Connected${data?.version ? ` · v${data.version}` : ""}`
        : data?.reachable
          ? "Unauthorized"
          : "Unreachable"

  const labelTone =
    healthy || (checking && !data)
      ? "text-muted-foreground"
      : errorText && data?.reachable
        ? "text-foreground"
        : "text-destructive"

  return (
    <div className="flex items-center gap-1.5" title={errorText ?? undefined}>
      {checking && !data ? (
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
      ) : (
        <span className={cn("h-2 w-2 shrink-0 rounded-full", tone)} />
      )}
      <span className={cn("truncate text-xs", labelTone)}>{label}</span>
    </div>
  )
}
