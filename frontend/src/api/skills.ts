import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"

import { api } from "./client"
import type {
  Skill,
  SkillAssignmentInput,
  SkillIngestInput,
  SkillInput,
  SkillOrigin,
  SkillScanResult,
} from "./types"

/** Which slice of the catalog to list.
 *
 *  `all` — everything; `global` — assigned everywhere; `unassigned` — in the
 *  catalog but applying nowhere; `workspace` — everything in scope for one
 *  workspace, each row tagged with the layer it won at; `local` — skills living
 *  in one of a repo's skill roots; `user` — skills discovered in a personal
 *  directory owned by another tool. */
export type SkillAssignmentFilter =
  | "all"
  | "global"
  | "unassigned"
  | "workspace"
  | "local"
  | "user"

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
  /** Re-point a skill: global, a set of workspaces, or nowhere. Works on a catalog
   *  skill and on a personal one (whose files stay where they are); only a
   *  repo-committed skill has no assignment to change. */
  setAssignment: (id: string, input: SkillAssignmentInput) =>
    api.put<Skill>(`/skills/${id}/assignment`, input),
  /** Move a repo-local skill's folder into the catalog so it can be reassigned.
   *  Only for a root Lursor owns (`.agents/skills`) — see `copy`. */
  promote: (id: string) => api.post<Skill>(`/skills/${id}/promote`, {}),
  /** Duplicate a discovered skill into the catalog, leaving the source in place.
   *  Takes a snapshot, which then drifts from the original — see `link` for the
   *  version that doesn't. */
  copy: (id: string) => api.post<Skill>(`/skills/${id}/copy`, {}),
  /** Symlink a personal skill into the catalog, still reading the original file.
   *  The skill keeps its id and its reach; it just becomes editable from the Skill
   *  Studio — and an edit there is an edit to the other tool's copy. */
  link: (id: string) => api.post<Skill>(`/skills/${id}/link`, {}),
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
  /** Skill folders sitting in a workspace directory — what the file explorer asks
   *  before offering to ingest a folder. Read-only. */
  scan: (workspaceId: string, path: string, signal?: AbortSignal) =>
    api.get<SkillScanResult>(
      `/skills/scan?workspace_id=${encodeURIComponent(workspaceId)}&path=${encodeURIComponent(path)}`,
      signal
    ),
  /** Ingest skill folders already on disk in a workspace, no upload. The source
   *  folder is copied, never moved — nothing in the repo changes. */
  ingest: (input: SkillIngestInput) => api.post<Skill[]>("/skills/ingest", input),
}

export const skillKeys = {
  all: ["skills"] as const,
  list: (filter?: SkillListFilter) =>
    ["skills", filter?.assignment ?? "all", filter?.workspace_id ?? null] as const,
  detail: (id: string) => ["skills", id] as const,
  file: (id: string, path: string) => ["skills", id, "file", path] as const,
  scan: (workspaceId: string, path: string) =>
    ["skills", "scan", workspaceId, path] as const,
}

export function useSkills(filter?: SkillListFilter) {
  return useQuery({
    queryKey: skillKeys.list(filter),
    queryFn: ({ signal }) => skillsApi.list(filter, signal),
  })
}

/**
 * One file from inside a skill folder, as a cached query.
 *
 * The editor reads files imperatively through `skillsApi.readFile` because it
 * owns dirty buffers; a read-only preview wants the opposite — a key it can be
 * cached under, so arrowing down a list of skills doesn't refetch what it has
 * already shown. Keyed under the skill, so any write invalidating `skillKeys.all`
 * refreshes the preview too.
 */
export function useSkillFile(id: string | undefined, path: string) {
  return useQuery({
    queryKey: skillKeys.file(id ?? "", path),
    queryFn: ({ signal }) => skillsApi.readFile(id ?? "", path, signal),
    enabled: Boolean(id),
    staleTime: 30_000,
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

export function useCopySkill() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => skillsApi.copy(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  })
}

export function useLinkSkill() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => skillsApi.link(id),
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

/**
 * Look for skill folders in a workspace directory. Deliberately lazy: `enabled`
 * is what a context menu flips when it opens, so nothing is scanned until the
 * user actually asks about a folder.
 */
export function useSkillScan(
  workspaceId: string,
  path: string,
  enabled: boolean
) {
  return useQuery({
    queryKey: skillKeys.scan(workspaceId, path),
    queryFn: ({ signal }) => skillsApi.scan(workspaceId, path, signal),
    enabled,
    staleTime: 30_000,
  })
}

export function useIngestSkills() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: SkillIngestInput) => skillsApi.ingest(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillKeys.all }),
  })
}
