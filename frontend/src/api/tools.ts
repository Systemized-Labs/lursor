import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"

import { api } from "./client"
import type { Tool, ToolInput } from "./types"

export const toolsApi = {
  list: (signal?: AbortSignal) => api.get<Tool[]>("/tools", signal),
  get: (id: string, signal?: AbortSignal) =>
    api.get<Tool>(`/tools/${id}`, signal),
  create: (input: ToolInput) => api.post<Tool>("/tools", input),
  update: (id: string, input: Partial<ToolInput>) =>
    api.patch<Tool>(`/tools/${id}`, input),
  remove: (id: string) => api.delete<void>(`/tools/${id}`),
}

export const toolKeys = {
  all: ["tools"] as const,
  detail: (id: string) => ["tools", id] as const,
}

export function useTools() {
  return useQuery({
    queryKey: toolKeys.all,
    queryFn: ({ signal }) => toolsApi.list(signal),
  })
}

export function useCreateTool() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: ToolInput) => toolsApi.create(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: toolKeys.all }),
  })
}

export function useUpdateTool() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<ToolInput> }) =>
      toolsApi.update(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: toolKeys.all }),
  })
}

export function useDeleteTool() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => toolsApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: toolKeys.all }),
  })
}
