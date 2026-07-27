import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"

import { api } from "./client"
import type {
  Skill,
  SkillAssignmentInput,
  SkillInput,
  SkillOrigin,
} from "./types"

/** Which slice of the catalog to list.
 *
 *  `all` — everything; `global` — assigned everywhere; `unassigned` — in the
 *  catalog but applying nowhere; `workspace` — everything in scope for one
 *  workspace, each row tagged with the layer it won at; `local` — skills living
 *  in a repo's `.agents/skills`. */
export type SkillAssignmentFilter =
  | "all"
  | "global"
  | "unassigned"
  | "workspace"
  | "local"

export interface SkillListFilter {
  assignment?: SkillAssignmentFilter
  workspace_id?: string | null
}

/** Where an import should land. */
export interface SkillTarget {
  origin?: SkillOrigin
  workspace_id?: string | null
  is_global?: boolean
}

function listQuery(filter?: SkillListFilter): string {
  const params = new URLSearchParams()
  if (filter?.assignment) params.set("assignment", filter.assignment)
  if (filter?.workspace_id) params.set("workspace_id", filter.workspace_id)
  const qs = params.toString()
  return qs ? `?${qs}` : ""
}

function targetQuery(target?: SkillTarget): string {
  const params = new URLSearchParams()
  if (target?.origin) params.set("origin", target.origin)
  if (target?.workspace_id) params.set("workspace_id", target.workspace_id)
  if (target?.is_global !== undefined)
    params.set("is_global", String(target.is_global))
  const qs = params.toString()
  return qs ? `?${qs}` : ""
}

/** Encode a skill-relative file path, keeping its folder separators. */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/")
}

export const skillsApi = {
  list: (filter?: SkillListFilter, signal?: AbortSignal) =>
    api.get<Skill[]>(`/skills${listQuery(filter)}`, signal),
  get: (id: string, signal?: AbortSignal) =>
    api.get<Skill>(`/skills/${id}`, signal),
  create: (input: SkillInput) => api.post<Skill>("/skills", input),
  update: (id: string, input: Partial<SkillInput>) =>
    api.patch<Skill>(`/skills/${id}`, input),
  remove: (id: string) => api.delete<void>(`/skills/${id}`),
  /** Re-point a managed skill: global, a set of workspaces, or nowhere. */
  setAssignment: (id: string, input: SkillAssignmentInput) =>
    api.put<Skill>(`/skills/${id}/assignment`, input),
  /** Move a repo-local skill's folder into the catalog so it can be reassigned. */
  promote: (id: string) => api.post<Skill>(`/skills/${id}/promote`, {}),
  // Files inside the skill folder, including SKILL.md itself — the editor works
  // on the real files, so frontmatter the UI doesn't model survives a save.
  readFile: (id: string, path: string, signal?: AbortSignal) =>
    api.get<{ content: string }>(`/skills/${id}/files/${encodePath(path)}`, signal),
  writeFile: (id: string, path: string, content: string) =>
    api.put<Skill>(`/skills/${id}/files/${encodePath(path)}`, { content }),
  deleteFile: (id: string, path: string) =>
    api.delete<Skill>(`/skills/${id}/files/${encodePath(path)}`),
  import: (files: File[], target?: SkillTarget) => {
    const form = new FormData()
    for (const file of files) {
      // Preserve each file's path within the picked folder (webkitRelativePath,
      // e.g. "pdf-tools/SKILL.md") so the server can rebuild the folder tree.
      // Falls back to the plain name for single-file (.zip / .md) uploads.
      const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath
      form.append("files", file, rel && rel.length > 0 ? rel : file.name)
    }
    return api.upload<Skill[]>(`/skills/import${targetQuery(target)}`, form)
  },
}

export const skillKeys = {
  all: ["skills"] as const,
  list: (filter?: SkillListFilter) =>
    ["skills", filter?.assignment ?? "all", filter?.workspace_id ?? null] as const,
  detail: (id: string) => ["skills", id] as const,
}

export function useSkills(filter?: SkillListFilter) {
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

export function useSetSkillAssignment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: SkillAssignmentInput }) =>
      skillsApi.setAssignment(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  })
}

export function usePromoteSkill() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => skillsApi.promote(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  })
}

export function useDeleteSkillFile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, path }: { id: string; path: string }) =>
      skillsApi.deleteFile(id, path),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  })
}

export function useImportSkills() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ files, target }: { files: File[]; target?: SkillTarget }) =>
      skillsApi.import(files, target),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  })
}
