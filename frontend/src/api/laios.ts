import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"

import { api } from "./client"
import type {
  LaiosBudget,
  LaiosConnection,
  LaiosConnectionInput,
  LaiosConnectionStatus,
  LaiosInstance,
  LaiosInstanceLogs,
  LaiosRecipeSummary,
  LaiosServeInput,
} from "./types"

// All model-lifecycle calls are scoped to a connection id; the backend proxies
// them to that daemon's control plane holding the master_key server-side.
export const laiosApi = {
  listConnections: (signal?: AbortSignal) =>
    api.get<LaiosConnection[]>("/laios/connections", signal),
  createConnection: (input: LaiosConnectionInput) =>
    api.post<LaiosConnection>("/laios/connections", input),
  updateConnection: (id: string, input: Partial<LaiosConnectionInput>) =>
    api.patch<LaiosConnection>(`/laios/connections/${id}`, input),
  removeConnection: (id: string) =>
    api.delete<void>(`/laios/connections/${id}`),
  status: (id: string, signal?: AbortSignal) =>
    api.get<LaiosConnectionStatus>(`/laios/connections/${id}/status`, signal),
  instances: (id: string, signal?: AbortSignal) =>
    api.get<LaiosInstance[]>(`/laios/connections/${id}/instances`, signal),
  catalog: (id: string, signal?: AbortSignal) =>
    api.get<LaiosRecipeSummary[]>(`/laios/connections/${id}/catalog`, signal),
  budget: (id: string, signal?: AbortSignal) =>
    api.get<LaiosBudget>(`/laios/connections/${id}/budget`, signal),
  serve: (id: string, input: LaiosServeInput) =>
    api.post<LaiosInstance>(`/laios/connections/${id}/serve`, input),
  stop: (id: string, instanceId: string) =>
    api.post<LaiosInstance>(
      `/laios/connections/${id}/instances/${instanceId}/stop`,
      {}
    ),
  logs: (id: string, instanceId: string, tail = 200, signal?: AbortSignal) =>
    api.get<LaiosInstanceLogs>(
      `/laios/connections/${id}/instances/${instanceId}/logs?tail=${tail}`,
      signal
    ),
}

export const laiosKeys = {
  all: ["laios"] as const,
  connections: ["laios", "connections"] as const,
  status: (id: string) => ["laios", id, "status"] as const,
  instances: (id: string) => ["laios", id, "instances"] as const,
  catalog: (id: string) => ["laios", id, "catalog"] as const,
  budget: (id: string) => ["laios", id, "budget"] as const,
  logs: (id: string, instanceId: string) =>
    ["laios", id, "logs", instanceId] as const,
}

export function useLaiosConnections() {
  return useQuery({
    queryKey: laiosKeys.connections,
    queryFn: ({ signal }) => laiosApi.listConnections(signal),
  })
}

// Probe is explicit + polled: it reaches the user's daemon (possibly remote),
// so no focus refetch, and a failure is a status ("down"), not a retry loop.
export function useLaiosStatus(id: string | undefined) {
  return useQuery({
    queryKey: id ? laiosKeys.status(id) : laiosKeys.all,
    queryFn: ({ signal }) => laiosApi.status(id as string, signal),
    enabled: Boolean(id),
    staleTime: 10_000,
    refetchInterval: 15_000,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

export function useLaiosInstances(id: string | undefined) {
  return useQuery({
    queryKey: id ? laiosKeys.instances(id) : laiosKeys.all,
    queryFn: ({ signal }) => laiosApi.instances(id as string, signal),
    enabled: Boolean(id),
    // Poll so spin up/down + starting→running transitions surface on their own.
    refetchInterval: 4_000,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

export function useLaiosCatalog(id: string | undefined) {
  return useQuery({
    queryKey: id ? laiosKeys.catalog(id) : laiosKeys.all,
    queryFn: ({ signal }) => laiosApi.catalog(id as string, signal),
    enabled: Boolean(id),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

export function useLaiosBudget(id: string | undefined) {
  return useQuery({
    queryKey: id ? laiosKeys.budget(id) : laiosKeys.all,
    queryFn: ({ signal }) => laiosApi.budget(id as string, signal),
    enabled: Boolean(id),
    refetchInterval: 8_000,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

// --- Connection mutations (invalidate the connections list) ---------------------

function useConnectionMutation<TArgs>(fn: (args: TArgs) => Promise<unknown>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: laiosKeys.connections })
    },
  })
}

export function useCreateLaiosConnection() {
  return useConnectionMutation((input: LaiosConnectionInput) =>
    laiosApi.createConnection(input)
  )
}

export function useUpdateLaiosConnection() {
  return useConnectionMutation(
    ({ id, input }: { id: string; input: Partial<LaiosConnectionInput> }) =>
      laiosApi.updateConnection(id, input)
  )
}

export function useDeleteLaiosConnection() {
  return useConnectionMutation((id: string) => laiosApi.removeConnection(id))
}

// --- Lifecycle mutations (invalidate the active connection's instances/budget) --

function useLifecycleMutation<TArgs, TData>(
  connectionId: string,
  fn: (args: TArgs) => Promise<TData>
) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSettled: () => {
      qc.invalidateQueries({ queryKey: laiosKeys.instances(connectionId) })
      qc.invalidateQueries({ queryKey: laiosKeys.budget(connectionId) })
    },
  })
}

export function useServeModel(connectionId: string) {
  return useLifecycleMutation(connectionId, (input: LaiosServeInput) =>
    laiosApi.serve(connectionId, input)
  )
}

export function useStopInstance(connectionId: string) {
  return useLifecycleMutation(connectionId, (instanceId: string) =>
    laiosApi.stop(connectionId, instanceId)
  )
}
