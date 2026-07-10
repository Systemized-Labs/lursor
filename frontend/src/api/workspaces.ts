import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"

import { api } from "./client"
import type { Workspace, WorkspaceInput } from "./types"

export const workspacesApi = {
  list: (signal?: AbortSignal) => api.get<Workspace[]>("/workspaces", signal),
  get: (id: string, signal?: AbortSignal) =>
    api.get<Workspace>(`/workspaces/${id}`, signal),
  create: (input: WorkspaceInput) =>
    api.post<Workspace>("/workspaces", input),
  update: (id: string, input: Partial<WorkspaceInput>) =>
    api.patch<Workspace>(`/workspaces/${id}`, input),
  remove: (id: string) => api.delete<void>(`/workspaces/${id}`),
  // Opens the OS folder explorer on the machine running the backend. Returns
  // the chosen path, or null if the user cancelled the dialog.
  pickFolder: () =>
    api.post<{ path: string | null }>("/workspaces/pick-folder", {}),
}

export const workspaceKeys = {
  all: ["workspaces"] as const,
  detail: (id: string) => ["workspaces", id] as const,
}

export function useWorkspaces() {
  return useQuery({
    queryKey: workspaceKeys.all,
    queryFn: ({ signal }) => workspacesApi.list(signal),
  })
}

export function useWorkspace(id: string | undefined) {
  return useQuery({
    queryKey: workspaceKeys.detail(id ?? ""),
    queryFn: ({ signal }) => workspacesApi.get(id as string, signal),
    enabled: Boolean(id),
  })
}

export function useCreateWorkspace() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: WorkspaceInput) => workspacesApi.create(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: workspaceKeys.all }),
  })
}

export function useUpdateWorkspace() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string
      input: Partial<WorkspaceInput>
    }) => workspacesApi.update(id, input),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: workspaceKeys.all })
      qc.invalidateQueries({ queryKey: workspaceKeys.detail(variables.id) })
    },
  })
}

export function useDeleteWorkspace() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => workspacesApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: workspaceKeys.all }),
  })
}
