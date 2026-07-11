import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"

import { api } from "./client"
import type { PromptTemplate, PromptTemplateInput } from "./types"

export const promptTemplatesApi = {
  list: (signal?: AbortSignal) =>
    api.get<PromptTemplate[]>("/prompt-templates", signal),
  get: (id: string, signal?: AbortSignal) =>
    api.get<PromptTemplate>(`/prompt-templates/${id}`, signal),
  create: (input: PromptTemplateInput) =>
    api.post<PromptTemplate>("/prompt-templates", input),
  update: (id: string, input: Partial<PromptTemplateInput>) =>
    api.patch<PromptTemplate>(`/prompt-templates/${id}`, input),
  remove: (id: string) => api.delete<void>(`/prompt-templates/${id}`),
}

export const promptTemplateKeys = {
  all: ["prompt-templates"] as const,
  detail: (id: string) => ["prompt-templates", id] as const,
}

export function usePromptTemplates() {
  return useQuery({
    queryKey: promptTemplateKeys.all,
    queryFn: ({ signal }) => promptTemplatesApi.list(signal),
  })
}

export function useCreatePromptTemplate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: PromptTemplateInput) => promptTemplatesApi.create(input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: promptTemplateKeys.all }),
  })
}

export function useUpdatePromptTemplate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string
      input: Partial<PromptTemplateInput>
    }) => promptTemplatesApi.update(id, input),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: promptTemplateKeys.all }),
  })
}

export function useDeletePromptTemplate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => promptTemplatesApi.remove(id),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: promptTemplateKeys.all }),
  })
}
