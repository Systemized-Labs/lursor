import { useQuery } from "@tanstack/react-query"

import { api } from "./client"

/** A subdirectory of the browsed path. */
export interface DirEntry {
  name: string
  path: string
  /** Holds a `.git` — almost always what you're looking for in a workspace picker. */
  is_repo: boolean
}

/** One directory on the backend host. See `backend/app/api/fs.py`. */
export interface DirListing {
  path: string
  /** Null at the filesystem root, which is what stops the "up" control. */
  parent: string | null
  home: string
  entries: DirEntry[]
  /** True when the directory held more entries than the backend will list. */
  truncated: boolean
}

/** What the backend can do on the machine it runs on. See `GET /api/server-info`. */
export interface ServerInfo {
  app: string
  platform: string
  /**
   * Whether the backend can show a native OS folder dialog. False on a headless
   * host (a VPS), where the picker has to browse the filesystem over the API
   * instead — there is no display to draw a dialog on.
   */
  can_pick_folder: boolean
  auth_required: boolean
}

export const fsApi = {
  listDirs: (path: string, showHidden = false, signal?: AbortSignal) =>
    api.get<DirListing>(
      `/fs/dirs?path=${encodeURIComponent(path)}&show_hidden=${showHidden}`,
      signal
    ),
  serverInfo: (signal?: AbortSignal) => api.get<ServerInfo>("/server-info", signal),
}

export const fsKeys = {
  dirs: (path: string, showHidden: boolean) =>
    ["fs", "dirs", path, showHidden] as const,
  serverInfo: () => ["fs", "server-info"] as const,
}

/**
 * Facts about the backend's host. Cached indefinitely: none of it can change
 * without the backend restarting, which means a new connection anyway.
 */
export function useServerInfo() {
  return useQuery({
    queryKey: fsKeys.serverInfo(),
    queryFn: ({ signal }) => fsApi.serverInfo(signal),
    staleTime: Infinity,
  })
}

/** List directories on the backend host. */
export function useDirListing(
  path: string,
  showHidden: boolean,
  enabled: boolean
) {
  return useQuery({
    queryKey: fsKeys.dirs(path, showHidden),
    queryFn: ({ signal }) => fsApi.listDirs(path, showHidden, signal),
    enabled,
    // The filesystem moves under us — an agent creating a directory is routine —
    // so don't serve a listing from cache on reopen.
    staleTime: 0,
  })
}
