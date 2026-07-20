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
  /** Absolute URL to a file's raw bytes — usable directly as an `<img src>`. */
  rawUrl: (workspaceId: string, path: string) =>
    `${API_BASE}/workspaces/${workspaceId}/files/raw?path=${encodeURIComponent(path)}`,
  search: (workspaceId: string, query = "", limit = 50, signal?: AbortSignal) =>
    api.get<DirEntry[]>(
      `/workspaces/${workspaceId}/files/search?q=${encodeURIComponent(query)}&limit=${limit}`,
      signal
    ),
  write: (workspaceId: string, path: string, content: string) =>
    api.put<{ path: string; size: number }>(
      `/workspaces/${workspaceId}/files/write`,
      { path, content }
    ),
  /** Upload files into a workspace folder ("" for the root). Bytes round-trip
   * verbatim, so binary files (images, archives, …) upload intact. */
  upload: (workspaceId: string, path: string, files: File[]) => {
    const form = new FormData()
    form.append("path", path)
    for (const file of files) {
      // Preserve any relative subpath the browser attached (folder uploads).
      form.append("files", file, file.webkitRelativePath || file.name)
    }
    return api.upload<DirEntry[]>(
      `/workspaces/${workspaceId}/files/upload`,
      form
    )
  },
  create: (workspaceId: string, path: string, isDir: boolean) =>
    api.post<DirEntry>(`/workspaces/${workspaceId}/files/create`, {
      path,
      is_dir: isDir,
    }),
  rename: (workspaceId: string, path: string, newPath: string) =>
    api.post<DirEntry>(`/workspaces/${workspaceId}/files/rename`, {
      path,
      new_path: newPath,
    }),
  remove: (workspaceId: string, path: string) =>
    api.delete<void>(
      `/workspaces/${workspaceId}/files/delete?path=${encodeURIComponent(path)}`
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
