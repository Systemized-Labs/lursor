import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"

import { api } from "./client"
import type { Agent, AgentInput } from "./types"

export const agentsApi = {
  list: (signal?: AbortSignal) => api.get<Agent[]>("/agents", signal),
  get: (id: string, signal?: AbortSignal) =>
    api.get<Agent>(`/agents/${id}`, signal),
  create: (input: AgentInput) => api.post<Agent>("/agents", input),
  update: (id: string, input: Partial<AgentInput>) =>
    api.patch<Agent>(`/agents/${id}`, input),
  remove: (id: string) => api.delete<void>(`/agents/${id}`),
}

export const agentKeys = {
  all: ["agents"] as const,
  detail: (id: string) => ["agents", id] as const,
}

export function useAgents() {
  return useQuery({
    queryKey: agentKeys.all,
    queryFn: ({ signal }) => agentsApi.list(signal),
  })
}

export function useAgent(id: string | undefined) {
  return useQuery({
    queryKey: agentKeys.detail(id ?? ""),
    queryFn: ({ signal }) => agentsApi.get(id as string, signal),
    enabled: Boolean(id),
  })
}

export function useCreateAgent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: AgentInput) => agentsApi.create(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: agentKeys.all }),
  })
}

export function useUpdateAgent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<AgentInput> }) =>
      agentsApi.update(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: agentKeys.all }),
  })
}

export function useDeleteAgent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => agentsApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: agentKeys.all }),
  })
}
