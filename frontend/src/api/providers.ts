import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"

import { api } from "./client"
import { modelKeys } from "./models"
import type {
  CustomProvider,
  CustomProviderInput,
  ProviderHealth,
} from "./types"

export const providersApi = {
  list: (signal?: AbortSignal) => api.get<CustomProvider[]>("/providers", signal),
  get: (id: string, signal?: AbortSignal) =>
    api.get<CustomProvider>(`/providers/${id}`, signal),
  create: (input: CustomProviderInput) =>
    api.post<CustomProvider>("/providers", input),
  update: (id: string, input: Partial<CustomProviderInput>) =>
    api.patch<CustomProvider>(`/providers/${id}`, input),
  remove: (id: string) => api.delete<void>(`/providers/${id}`),
  health: (id: string, signal?: AbortSignal) =>
    api.get<ProviderHealth>(`/providers/${id}/health`, signal),
  test: (input: CustomProviderInput) =>
    api.post<ProviderHealth>("/providers/test", input),
}

export const providerKeys = {
  all: ["providers"] as const,
  detail: (id: string) => ["providers", id] as const,
  health: (id: string) => ["providers", id, "health"] as const,
}

// Probes the provider's endpoint so the UI can flag misconfigured providers.
// Not auto-refetched on focus — a probe hits the user's own server, so we keep
// it explicit (initial load + manual refresh via the card's retry button).
export function useProviderHealth(id: string) {
  return useQuery({
    queryKey: providerKeys.health(id),
    queryFn: ({ signal }) => providersApi.health(id, signal),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

export function useProviders() {
  return useQuery({
    queryKey: providerKeys.all,
    queryFn: ({ signal }) => providersApi.list(signal),
  })
}

// Changing a provider changes which models the picker can list, so invalidate
// both the providers list and the model catalogue on every mutation.
function useProviderMutation<TArgs>(fn: (args: TArgs) => Promise<unknown>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: providerKeys.all })
      qc.invalidateQueries({ queryKey: modelKeys.all })
    },
  })
}

export function useCreateProvider() {
  return useProviderMutation((input: CustomProviderInput) =>
    providersApi.create(input)
  )
}

export function useUpdateProvider() {
  return useProviderMutation(
    ({ id, input }: { id: string; input: Partial<CustomProviderInput> }) =>
      providersApi.update(id, input)
  )
}

export function useDeleteProvider() {
  return useProviderMutation((id: string) => providersApi.remove(id))
}
