import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"

import { api } from "./client"
import type {
  Agent,
  AgentInput,
  PromptGenerateRequest,
  PromptImproveRequest,
  PromptResult,
} from "./types"

export const agentsApi = {
  list: (signal?: AbortSignal) => api.get<Agent[]>("/agents", signal),
  get: (id: string, signal?: AbortSignal) =>
    api.get<Agent>(`/agents/${id}`, signal),
  create: (input: AgentInput) => api.post<Agent>("/agents", input),
  update: (id: string, input: Partial<AgentInput>) =>
    api.patch<Agent>(`/agents/${id}`, input),
  remove: (id: string) => api.delete<void>(`/agents/${id}`),
  generatePrompt: (input: PromptGenerateRequest) =>
    api.post<PromptResult>("/agents/prompt/generate", input),
  improvePrompt: (input: PromptImproveRequest) =>
    api.post<PromptResult>("/agents/prompt/improve", input),
}

export const agentKeys = {
  all: ["agents"] as const,
  detail: (id: string) => ["agents", id] as const,
}

/**
 * The user's agents — every agent picker, list and settings row reads this.
 *
 * The top-level Assistant is filtered out here rather than at each call site.
 * It is not one of your agents: it can't be edited, deleted, assigned to a
 * schedule, or picked in a composer, so every consumer would otherwise need the
 * same guard and one of them would eventually be missed. `is_assistant` is
 * computed server-side (`schemas/agent.py`).
 */
export function useAgents() {
  return useQuery({
    queryKey: agentKeys.all,
    queryFn: ({ signal }) => agentsApi.list(signal),
    select: (agents) => agents.filter((a) => !a.is_assistant),
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

export function useGeneratePrompt() {
  return useMutation({
    mutationFn: (input: PromptGenerateRequest) => agentsApi.generatePrompt(input),
  })
}

export function useImprovePrompt() {
  return useMutation({
    mutationFn: (input: PromptImproveRequest) => agentsApi.improvePrompt(input),
  })
}
