import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"

import { api } from "./client"
import type { Skill, SkillInput } from "./types"

export const skillsApi = {
  list: (signal?: AbortSignal) => api.get<Skill[]>("/skills", signal),
  get: (id: string, signal?: AbortSignal) =>
    api.get<Skill>(`/skills/${id}`, signal),
  create: (input: SkillInput) => api.post<Skill>("/skills", input),
  update: (id: string, input: Partial<SkillInput>) =>
    api.patch<Skill>(`/skills/${id}`, input),
  remove: (id: string) => api.delete<void>(`/skills/${id}`),
}

export const skillKeys = {
  all: ["skills"] as const,
  detail: (id: string) => ["skills", id] as const,
}

export function useSkills() {
  return useQuery({
    queryKey: skillKeys.all,
    queryFn: ({ signal }) => skillsApi.list(signal),
  })
}

export function useCreateSkill() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: SkillInput) => skillsApi.create(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  })
}

export function useUpdateSkill() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: Partial<SkillInput> }) =>
      skillsApi.update(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  })
}

export function useDeleteSkill() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => skillsApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  })
}
