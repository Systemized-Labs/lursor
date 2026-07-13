import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"

import { api } from "./client"
import type {
  BuiltinOverrideInput,
  Subagent,
  SubagentDefaults,
  SubagentDefaultsUpdate,
  SubagentInput,
} from "./types"

export const subagentsApi = {
  list: (signal?: AbortSignal) => api.get<Subagent[]>("/subagents", signal),
  get: (id: string, signal?: AbortSignal) =>
    api.get<Subagent>(`/subagents/${id}`, signal),
  create: (input: SubagentInput) => api.post<Subagent>("/subagents", input),
  update: (id: string, input: Partial<SubagentInput>) =>
    api.patch<Subagent>(`/subagents/${id}`, input),
  remove: (id: string) => api.delete<void>(`/subagents/${id}`),

  // Defaults: pydantic-deep built-in subagents + governing knobs.
  getDefaults: (signal?: AbortSignal) =>
    api.get<SubagentDefaults>("/subagents/defaults", signal),
  updateDefaults: (input: SubagentDefaultsUpdate) =>
    api.put<SubagentDefaults>("/subagents/defaults", input),
  overrideBuiltin: (name: string, input: BuiltinOverrideInput) =>
    api.put<SubagentDefaults>(
      `/subagents/builtins/${encodeURIComponent(name)}`,
      input
    ),
  resetBuiltin: (name: string) =>
    api.delete<SubagentDefaults>(
      `/subagents/builtins/${encodeURIComponent(name)}`
    ),
}

export const subagentKeys = {
  all: ["subagents"] as const,
  detail: (id: string) => ["subagents", id] as const,
  defaults: ["subagents", "defaults"] as const,
}

export function useSubagents() {
  return useQuery({
    queryKey: subagentKeys.all,
    queryFn: ({ signal }) => subagentsApi.list(signal),
  })
}

export function useCreateSubagent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: SubagentInput) => subagentsApi.create(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: subagentKeys.all }),
  })
}

export function useUpdateSubagent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<SubagentInput> }) =>
      subagentsApi.update(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: subagentKeys.all }),
  })
}

export function useDeleteSubagent() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => subagentsApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: subagentKeys.all }),
  })
}

export function useSubagentDefaults() {
  return useQuery({
    queryKey: subagentKeys.defaults,
    queryFn: ({ signal }) => subagentsApi.getDefaults(signal),
  })
}

export function useUpdateSubagentDefaults() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: SubagentDefaultsUpdate) =>
      subagentsApi.updateDefaults(input),
    onSuccess: (data) => qc.setQueryData(subagentKeys.defaults, data),
  })
}

export function useOverrideBuiltin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ name, input }: { name: string; input: BuiltinOverrideInput }) =>
      subagentsApi.overrideBuiltin(name, input),
    onSuccess: (data) => {
      qc.setQueryData(subagentKeys.defaults, data)
      qc.invalidateQueries({ queryKey: subagentKeys.all })
    },
  })
}

export function useResetBuiltin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => subagentsApi.resetBuiltin(name),
    onSuccess: (data) => {
      qc.setQueryData(subagentKeys.defaults, data)
      qc.invalidateQueries({ queryKey: subagentKeys.all })
    },
  })
}
