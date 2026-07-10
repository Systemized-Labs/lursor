import { useQuery } from "@tanstack/react-query"

import { API_BASE, api } from "./client"

/** A single entry (file or directory) in a workspace directory listing. */
export interface DirEntry {
  name: string
  /** POSIX-style path relative to the workspace root ("" is the root). */
  path: string
  is_dir: boolean
}

/** A file's contents, with markers for the cases we don't render inline. */
export interface FileContent {
  path: string
  content: string
  is_binary: boolean
  size: number
  truncated: boolean
}

/** A filesystem change pushed over the watch WebSocket. */
export interface FileChange {
  type: "added" | "modified" | "deleted"
  path: string
}

export const filesApi = {
  list: (workspaceId: string, path = "", signal?: AbortSignal) =>
    api.get<DirEntry[]>(
      `/workspaces/${workspaceId}/files/list?path=${encodeURIComponent(path)}`,
      signal
    ),
  read: (workspaceId: string, path: string, signal?: AbortSignal) =>
    api.get<FileContent>(
      `/workspaces/${workspaceId}/files/read?path=${encodeURIComponent(path)}`,
      signal
    ),
  write: (workspaceId: string, path: string, content: string) =>
    api.put<{ path: string; size: number }>(
      `/workspaces/${workspaceId}/files/write`,
      { path, content }
    ),
}

export const fileKeys = {
  dir: (workspaceId: string, path: string) =>
    ["files", workspaceId, "dir", path] as const,
  file: (workspaceId: string, path: string) =>
    ["files", workspaceId, "file", path] as const,
}

/** List a directory's children (lazy tree loading). */
export function useDirectory(workspaceId: string | undefined, path: string) {
  return useQuery({
    queryKey: fileKeys.dir(workspaceId ?? "", path),
    queryFn: ({ signal }) => filesApi.list(workspaceId as string, path, signal),
    enabled: Boolean(workspaceId),
  })
}

/** Build the WebSocket URL for a workspace's file-watch endpoint. */
export function fileWatchWsUrl(workspaceId: string): string {
  const url = new URL(
    `${API_BASE.replace(/\/$/, "")}/workspaces/${workspaceId}/files/watch`
  )
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.toString()
}
