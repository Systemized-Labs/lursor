import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { api } from "./client"
import type {
  SidebarLayout,
  Workspace,
  WorkspaceFolder,
} from "./types"
import { workspaceKeys } from "./workspaces"

export const workspaceFoldersApi = {
  list: (signal?: AbortSignal) =>
    api.get<WorkspaceFolder[]>("/workspace-folders", signal),
  create: (name: string) =>
    api.post<WorkspaceFolder>("/workspace-folders", { name }),
  rename: (id: string, name: string) =>
    api.patch<WorkspaceFolder>(`/workspace-folders/${id}`, { name }),
  // Deletes the group only — its workspaces resurface at the root.
  remove: (id: string) => api.delete<void>(`/workspace-folders/${id}`),
  // Replaces the whole arrangement (see `SidebarLayout`).
  saveLayout: (layout: SidebarLayout) =>
    api.put<WorkspaceFolder[]>("/workspace-folders/layout", layout),
}

export const workspaceFolderKeys = {
  all: ["workspace-folders"] as const,
}

export function useWorkspaceFolders() {
  return useQuery({
    queryKey: workspaceFolderKeys.all,
    queryFn: ({ signal }) => workspaceFoldersApi.list(signal),
  })
}

export function useCreateWorkspaceFolder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => workspaceFoldersApi.create(name),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: workspaceFolderKeys.all }),
  })
}

export function useRenameWorkspaceFolder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      workspaceFoldersApi.rename(id, name),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: workspaceFolderKeys.all }),
  })
}

export function useDeleteWorkspaceFolder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => workspaceFoldersApi.remove(id),
    // Deleting a group is a sidebar edit, so it has to feel like one: drop the
    // row now and let the workspaces it held reappear at the root on refetch.
    onMutate: async (id: string) => {
      await qc.cancelQueries({ queryKey: workspaceFolderKeys.all })
      const previous = qc.getQueryData<WorkspaceFolder[]>(
        workspaceFolderKeys.all
      )
      qc.setQueryData<WorkspaceFolder[]>(workspaceFolderKeys.all, (old) =>
        (old ?? []).filter((folder) => folder.id !== id)
      )
      return { previous }
    },
    onError: (_err, _id, context) => {
      if (context?.previous) {
        qc.setQueryData(workspaceFolderKeys.all, context.previous)
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: workspaceFolderKeys.all })
      qc.invalidateQueries({ queryKey: workspaceKeys.all })
    },
  })
}

/**
 * Persists a drag. The dragged row has to land under the cursor immediately —
 * a list that snaps back for a round-trip reads as a failed drop — so the new
 * arrangement is written into the caches first and rolled back if the request
 * fails.
 */
export function useSaveSidebarLayout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (layout: SidebarLayout) =>
      workspaceFoldersApi.saveLayout(layout),
    onMutate: async (layout: SidebarLayout) => {
      await qc.cancelQueries({ queryKey: workspaceFolderKeys.all })
      await qc.cancelQueries({ queryKey: workspaceKeys.all })
      const previousFolders = qc.getQueryData<WorkspaceFolder[]>(
        workspaceFolderKeys.all
      )
      const previousWorkspaces = qc.getQueryData<Workspace[]>(workspaceKeys.all)

      const folderPositions = new Map(
        layout.folders.map((placement) => [placement.id, placement.position])
      )
      qc.setQueryData<WorkspaceFolder[]>(workspaceFolderKeys.all, (old) =>
        (old ?? []).map((folder) => {
          const position = folderPositions.get(folder.id)
          return position === undefined ? folder : { ...folder, position }
        })
      )

      const placements = new Map(
        layout.workspaces.map((placement) => [placement.id, placement])
      )
      qc.setQueryData<Workspace[]>(workspaceKeys.all, (old) =>
        (old ?? []).map((ws) => {
          const placement = placements.get(ws.id)
          return placement
            ? {
                ...ws,
                folder_id: placement.folder_id,
                position: placement.position,
              }
            : ws
        })
      )

      return { previousFolders, previousWorkspaces }
    },
    onError: (_err, _layout, context) => {
      if (context?.previousFolders) {
        qc.setQueryData(workspaceFolderKeys.all, context.previousFolders)
      }
      if (context?.previousWorkspaces) {
        qc.setQueryData(workspaceKeys.all, context.previousWorkspaces)
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: workspaceFolderKeys.all })
      qc.invalidateQueries({ queryKey: workspaceKeys.all })
    },
  })
}
