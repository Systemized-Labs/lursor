import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { API_BASE, api } from "./client"

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

/** A branch offered in the picker. `remote` is set only for a remote-tracking
 *  branch with no local copy yet (selecting it creates a local tracking branch). */
export interface BranchRef {
  name: string
  remote: string | null
}

/** Branches of the workspace's primary repo (local first, then remote-only). */
export interface GitBranches {
  is_repo: boolean
  current: string | null
  branches: BranchRef[]
}

export const gitApi = {
  diff: (workspaceId: string, signal?: AbortSignal) =>
    api.get<GitDiff>(`/workspaces/${workspaceId}/git/diff`, signal),
  branches: (workspaceId: string, signal?: AbortSignal) =>
    api.get<GitBranches>(`/workspaces/${workspaceId}/git/branches`, signal),
  checkout: (workspaceId: string, branch: string) =>
    api.post<GitBranches>(`/workspaces/${workspaceId}/git/checkout`, { branch }),
}

export const gitKeys = {
  diff: (workspaceId: string) => ["git", workspaceId, "diff"] as const,
  branches: (workspaceId: string) => ["git", workspaceId, "branches"] as const,
}

/** Build the WebSocket URL for a workspace's git-watch endpoint (state changes
 *  like commits, staging, and branch switches — see {@link useGitWatch}). */
export function gitWatchWsUrl(workspaceId: string): string {
  const url = new URL(
    `${API_BASE.replace(/\/$/, "")}/workspaces/${workspaceId}/git/watch`
  )
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.toString()
}

/** Fetch the workspace's uncommitted diff (powers the Changes panel). */
export function useGitDiff(workspaceId: string | undefined) {
  return useQuery({
    queryKey: gitKeys.diff(workspaceId ?? ""),
    queryFn: ({ signal }) => gitApi.diff(workspaceId as string, signal),
    enabled: Boolean(workspaceId),
  })
}

/** List the primary repo's local branches (most-recent first). */
export function useBranches(workspaceId: string | undefined) {
  return useQuery({
    queryKey: gitKeys.branches(workspaceId ?? ""),
    queryFn: ({ signal }) => gitApi.branches(workspaceId as string, signal),
    enabled: Boolean(workspaceId),
  })
}

/** Switch the workspace's primary repo to another local branch. */
export function useCheckoutBranch(workspaceId: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (branch: string) =>
      gitApi.checkout(workspaceId as string, branch),
    onSuccess: () => {
      if (!workspaceId) return
      qc.invalidateQueries({ queryKey: gitKeys.branches(workspaceId) })
      qc.invalidateQueries({ queryKey: gitKeys.diff(workspaceId) })
    },
  })
}
