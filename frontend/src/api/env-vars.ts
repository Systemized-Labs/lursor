import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { api } from "./client"
import type {
  EnvVar,
  EnvVarAssignmentInput,
  EnvVarInput,
  EnvVarUpdateInput,
  ResolvedEnv,
} from "./types"
import { skillKeys } from "./skills"

/** Narrow a listing to the vars that reach one workspace, or one skill. */
export interface EnvVarFilter {
  workspace_id?: string | null
  skill_id?: string | null
}

function filterQuery(filter?: EnvVarFilter): string {
  const params = new URLSearchParams()
  if (filter?.workspace_id) params.set("workspace_id", filter.workspace_id)
  if (filter?.skill_id) params.set("skill_id", filter.skill_id)
  const qs = params.toString()
  return qs ? `?${qs}` : ""
}

export const envVarsApi = {
  list: (filter?: EnvVarFilter, signal?: AbortSignal) =>
    api.get<EnvVar[]>(`/env-vars${filterQuery(filter)}`, signal),
  create: (input: EnvVarInput) => api.post<EnvVar>("/env-vars", input),
  update: (id: string, input: EnvVarUpdateInput) =>
    api.patch<EnvVar>(`/env-vars/${id}`, input),
  remove: (id: string) => api.delete<void>(`/env-vars/${id}`),
  setAssignment: (id: string, input: EnvVarAssignmentInput) =>
    api.put<EnvVar>(`/env-vars/${id}/assignment`, input),
  /** Effective environment for a workspace: keys and provenance, never values. */
  resolved: (workspaceId: string, signal?: AbortSignal) =>
    api.get<ResolvedEnv>(
      `/env-vars/resolved?workspace_id=${encodeURIComponent(workspaceId)}`,
      signal
    ),
}

export const envVarKeys = {
  all: ["env-vars"] as const,
  list: (filter?: EnvVarFilter) =>
    [
      "env-vars",
      filter?.workspace_id ?? null,
      filter?.skill_id ?? null,
    ] as const,
  resolved: (workspaceId: string) => ["env-vars", "resolved", workspaceId] as const,
}

export function useEnvVars(filter?: EnvVarFilter) {
  return useQuery({
    queryKey: envVarKeys.list(filter),
    queryFn: ({ signal }) => envVarsApi.list(filter, signal),
  })
}

export function useResolvedEnv(workspaceId: string | undefined) {
  return useQuery({
    queryKey: envVarKeys.resolved(workspaceId ?? ""),
    queryFn: ({ signal }) => envVarsApi.resolved(workspaceId as string, signal),
    enabled: Boolean(workspaceId),
  })
}

/** Assignments live on both sides, so a change invalidates skills too. */
function useEnvMutation<TArgs>(fn: (args: TArgs) => Promise<unknown>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: envVarKeys.all })
      void qc.invalidateQueries({ queryKey: skillKeys.all })
    },
  })
}

export function useCreateEnvVar() {
  return useEnvMutation((input: EnvVarInput) => envVarsApi.create(input))
}

export function useUpdateEnvVar() {
  return useEnvMutation(({ id, input }: { id: string; input: EnvVarUpdateInput }) =>
    envVarsApi.update(id, input)
  )
}

export function useDeleteEnvVar() {
  return useEnvMutation((id: string) => envVarsApi.remove(id))
}

export function useSetEnvVarAssignment() {
  return useEnvMutation(
    ({ id, input }: { id: string; input: EnvVarAssignmentInput }) =>
      envVarsApi.setAssignment(id, input)
  )
}
