import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"

import { api } from "./client"
import { modelKeys } from "./models"
import type { CustomProvider, CustomProviderInput } from "./types"

export const providersApi = {
  list: (signal?: AbortSignal) => api.get<CustomProvider[]>("/providers", signal),
  get: (id: string, signal?: AbortSignal) =>
    api.get<CustomProvider>(`/providers/${id}`, signal),
  create: (input: CustomProviderInput) =>
    api.post<CustomProvider>("/providers", input),
  update: (id: string, input: Partial<CustomProviderInput>) =>
    api.patch<CustomProvider>(`/providers/${id}`, input),
  remove: (id: string) => api.delete<void>(`/providers/${id}`),
}

export const providerKeys = {
  all: ["providers"] as const,
  detail: (id: string) => ["providers", id] as const,
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
