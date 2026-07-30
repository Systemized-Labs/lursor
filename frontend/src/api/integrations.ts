import { useQuery } from "@tanstack/react-query"

import { api } from "./client"
import type { HermesIntegration } from "./types"

export const integrationsApi = {
  hermes: (signal?: AbortSignal) =>
    api.get<HermesIntegration>("/integrations/hermes", signal),
}

export const integrationsKeys = {
  hermes: ["integrations", "hermes"] as const,
}

/**
 * State of the Hermes pairing: whether Hermes is installed here, whether our
 * plugin is present and enabled inside it, and the commands to fix whichever
 * step is missing.
 *
 * Everything it reports lives outside Lursor and can change while the page is
 * open — the user is expected to run a command in a terminal and come back — so
 * this refetches on focus rather than trusting a cached answer.
 */
export function useHermesIntegration() {
  return useQuery({
    queryKey: integrationsKeys.hermes,
    queryFn: ({ signal }) => integrationsApi.hermes(signal),
    refetchOnWindowFocus: true,
    staleTime: 0,
  })
}
