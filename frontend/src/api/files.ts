import { useQuery } from "@tanstack/react-query"

import { API_BASE, api } from "./client"

/** A single entry (file or directory) in a workspace directory listing. */
export interface DirEntry {
  name: string
  /** POSIX-style path relative to the workspace root ("" is the root). */
  path: string
  is_dir: boolean
  /** Where a symlinked entry actually points (absolute); empty for a real one.
   *  A linked skill looks exactly like a real folder without this, and which tool
   *  owns it decides what editing it affects. */
  link_target?: string
  /** Short form of the source for a badge: "~/.claude", "~/.hermes", or "Lursor"
   *  for a skill that really lives in the catalog. Empty when there is nothing to
   *  say — which is every row outside the catalog's top level that isn't a link. */
  source_label?: string
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

/** One matching line from a workspace content search. */
export interface GrepMatch {
  /** POSIX-style path relative to the workspace root. */
  path: string
  /** 1-based line number. */
  line: number
  /** 1-based column in the *real* line — what the editor jumps to. */
  column: number
  /** The matching line, windowed when the line was too long to render. */
  text: string
  match_length: number
  /** Characters dropped off the front of the line to build `text`; the match sits
   *  at `column - 1 - text_offset` within it. */
  text_offset: number
}

export interface GrepResult {
  matches: GrepMatch[]
  /** The search hit a cap — say so rather than implying these are all of them. */
  truncated: boolean
  files_scanned: number
}

/** Everything that decides a content search's result — also its query key. */
export interface GrepParams {
  q: string
  regex: boolean
  case: boolean
  wholeWord: boolean
  include: string
  limit?: number
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
  /** Absolute URL serving a file with its path in the URL instead of a query —
   *  what an HTML page needs to be framed, so its relative `<img>`/`<link>`/
   *  `<script>` references resolve against the sibling files on disk. */
  serveUrl: (workspaceId: string, path: string) =>
    `${API_BASE}/workspaces/${workspaceId}/files/serve/${path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
  search: (workspaceId: string, query = "", limit = 50, signal?: AbortSignal) =>
    api.get<DirEntry[]>(
      `/workspaces/${workspaceId}/files/search?q=${encodeURIComponent(query)}&limit=${limit}`,
      signal
    ),
  /** Search file *contents* across the workspace. Read-only — there is no
   *  replace-across-files counterpart by design. */
  grep: (workspaceId: string, params: GrepParams, signal?: AbortSignal) => {
    const query = new URLSearchParams({
      q: params.q,
      regex: String(params.regex),
      case: String(params.case),
      whole_word: String(params.wholeWord),
      limit: String(params.limit ?? 200),
    })
    if (params.include) query.set("include", params.include)
    return api.get<GrepResult>(
      `/workspaces/${workspaceId}/files/grep?${query.toString()}`,
      signal
    )
  },
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
  /** Keyed on the full parameter set: flipping `Aa` is a different search, not a
   *  refetch of the same one. */
  grep: (workspaceId: string, params: GrepParams) =>
    ["files", workspaceId, "grep", params] as const,
}

/**
 * Content search across a workspace.
 *
 * `placeholderData` keeps the previous result on screen while a new query is in
 * flight, so typing dims the list instead of blanking it — a results pane that
 * empties on every keystroke is unreadable at typing speed. Debouncing is the
 * caller's job (the query only changes once the input settles).
 */
export function useWorkspaceGrep(
  workspaceId: string | undefined,
  params: GrepParams
) {
  return useQuery({
    queryKey: fileKeys.grep(workspaceId ?? "", params),
    queryFn: ({ signal }) =>
      filesApi.grep(workspaceId as string, params, signal),
    enabled: Boolean(workspaceId) && params.q.trim().length > 0,
    placeholderData: (previous) => previous,
  })
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
