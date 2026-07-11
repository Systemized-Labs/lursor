import { useQueryClient } from "@tanstack/react-query"
import { WarningCircle, CheckCircle, ArrowsClockwise } from "@phosphor-icons/react"

import { providerKeys, useProviderHealth } from "@/api/providers"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DotGridLoader } from "@/components/ui/dot-grid-loader"

/**
 * Live status of a provider's endpoint, shown on its card so a misconfigured
 * provider (unreachable, missing API key, empty catalogue) is visible instead
 * of silently vanishing from the model picker.
 */
export function ProviderHealthBadge({ providerId }: { providerId: string }) {
  const qc = useQueryClient()
  const { data, isLoading, isError, isFetching } = useProviderHealth(providerId)

  function recheck() {
    qc.invalidateQueries({ queryKey: providerKeys.health(providerId) })
  }

  const checking = isLoading || isFetching
  // A failed request (non-2xx, e.g. 404) still means "something's wrong".
  const errorText = isError
    ? "Health check failed."
    : data?.status === "error"
      ? (data.error ?? "Something went wrong.")
      : null
  const healthy = !errorText && data?.status === "ok"

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        {checking ? (
          <Badge variant="secondary" className="gap-1 font-normal">
            <DotGridLoader size="2xs" />
            Checking…
          </Badge>
        ) : healthy ? (
          <Badge variant="success" className="gap-1 font-normal">
            <CheckCircle className="h-3 w-3" />
            Connected
            {typeof data?.model_count === "number"
              ? ` · ${data.model_count} model${data.model_count === 1 ? "" : "s"}`
              : ""}
          </Badge>
        ) : (
          <Badge variant="destructive" className="gap-1 font-normal">
            <WarningCircle className="h-3 w-3" />
            Issue
          </Badge>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={recheck}
          disabled={checking}
          aria-label="Re-check provider"
        >
          <ArrowsClockwise className="h-3 w-3" />
        </Button>
      </div>
      {!checking && errorText ? (
        <p className="text-xs text-destructive">{errorText}</p>
      ) : null}
    </div>
  )
}
