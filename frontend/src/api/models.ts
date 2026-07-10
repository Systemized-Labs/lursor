import { useQuery } from "@tanstack/react-query"

import { api } from "./client"
import type { ModelGroup } from "./types"

export const modelsApi = {
  list: (signal?: AbortSignal) => api.get<ModelGroup[]>("/models", signal),
}

export const modelKeys = {
  all: ["models"] as const,
}

/** Fetch the OpenRouter model catalogue, grouped by provider. */
export function useModels() {
  return useQuery({
    queryKey: modelKeys.all,
    queryFn: ({ signal }) => modelsApi.list(signal),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  })
}
