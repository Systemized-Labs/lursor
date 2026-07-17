import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"

import { api } from "./client"
import type { Skill, SkillInput, SkillScope } from "./types"

/** Restrict a listing/import to one scope (and, for workspace scope, one dir). */
export interface SkillScopeFilter {
  scope?: SkillScope
  workspace_id?: string | null
}

function scopeQuery(filter?: SkillScopeFilter): string {
  const params = new URLSearchParams()
  if (filter?.scope) params.set("scope", filter.scope)
  if (filter?.workspace_id) params.set("workspace_id", filter.workspace_id)
  const qs = params.toString()
  return qs ? `?${qs}` : ""
}

export const skillsApi = {
  list: (filter?: SkillScopeFilter, signal?: AbortSignal) =>
    api.get<Skill[]>(`/skills${scopeQuery(filter)}`, signal),
  get: (id: string, signal?: AbortSignal) =>
    api.get<Skill>(`/skills/${id}`, signal),
  create: (input: SkillInput) => api.post<Skill>("/skills", input),
  update: (id: string, input: Partial<SkillInput>) =>
    api.patch<Skill>(`/skills/${id}`, input),
  remove: (id: string) => api.delete<void>(`/skills/${id}`),
  import: (files: File[], filter?: SkillScopeFilter) => {
    const form = new FormData()
    for (const file of files) {
      // Preserve each file's path within the picked folder (webkitRelativePath,
      // e.g. "pdf-tools/SKILL.md") so the server can rebuild the folder tree.
      // Falls back to the plain name for single-file (.zip / .md) uploads.
      const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath
      form.append("files", file, rel && rel.length > 0 ? rel : file.name)
    }
    return api.upload<Skill[]>(`/skills/import${scopeQuery(filter)}`, form)
  },
}

export const skillKeys = {
  all: ["skills"] as const,
  list: (filter?: SkillScopeFilter) =>
    ["skills", filter?.scope ?? "all", filter?.workspace_id ?? null] as const,
  detail: (id: string) => ["skills", id] as const,
}

export function useSkills(filter?: SkillScopeFilter) {
  return useQuery({
    queryKey: skillKeys.list(filter),
    queryFn: ({ signal }) => skillsApi.list(filter, signal),
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

export function useImportSkills() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ files, filter }: { files: File[]; filter?: SkillScopeFilter }) =>
      skillsApi.import(files, filter),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  })
}
