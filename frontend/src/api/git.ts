import { useQuery } from "@tanstack/react-query"

import { api } from "./client"

/** Coarse kind of change for a file in the working tree. */
export type ChangeStatus = "added" | "modified" | "deleted"

/** One file that differs from HEAD, with its unified diff. */
export interface ChangedFile {
  /** Workspace-relative path (repo subdir prefix + repo-relative path). */
  path: string
  /** Workspace-relative repo root this file belongs to ("" = workspace root). */
  repo: string
  status: ChangeStatus
  additions: number
  deletions: number
  is_binary: boolean
  /** Patch omitted (empty) when the file is binary or too large to inline. */
  truncated: boolean
  diff: string
}

/** A git repo discovered under the workspace root. */
export interface RepoInfo {
  /** Workspace-relative repo root ("" = workspace root). */
  path: string
  branch: string | null
}

/** Uncommitted changes across every repo under the workspace (working tree vs HEAD). */
export interface GitDiff {
  /** Whether at least one git repo was found under the workspace. */
  is_repo: boolean
  branch: string | null
  repos: RepoInfo[]
  files: ChangedFile[]
  additions: number
  deletions: number
}

export const gitApi = {
  diff: (workspaceId: string, signal?: AbortSignal) =>
    api.get<GitDiff>(`/workspaces/${workspaceId}/git/diff`, signal),
}

export const gitKeys = {
  diff: (workspaceId: string) => ["git", workspaceId, "diff"] as const,
}

/** Fetch the workspace's uncommitted diff (powers the Changes panel). */
export function useGitDiff(workspaceId: string | undefined) {
  return useQuery({
    queryKey: gitKeys.diff(workspaceId ?? ""),
    queryFn: ({ signal }) => gitApi.diff(workspaceId as string, signal),
    enabled: Boolean(workspaceId),
  })
}
