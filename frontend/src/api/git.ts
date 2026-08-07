import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { api, connectWs } from "./client"

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

/** A file's working-tree state, at the granularity the file tree decorates rows
 *  with — finer than {@link ChangeStatus}, which only labels a diff. */
export type FileGitStatus =
  | "modified"
  | "added"
  | "untracked"
  | "deleted"
  | "conflicted"

/** One path git has something to say about, with no diff attached. */
export interface GitFileStatus {
  /** Workspace-relative path (repo subdir prefix + repo-relative path). */
  path: string
  status: FileGitStatus
  /** The index differs from HEAD — the change is at least partly staged. */
  staged: boolean
}

/** Every path under the workspace git has a state for: the cheap counterpart to
 *  {@link GitDiff}, used to decorate the file tree (no patches computed). */
export interface GitStatus {
  is_repo: boolean
  files: GitFileStatus[]
  /** Ignored paths; a trailing "/" marks a wholly-ignored directory and stands
   *  for everything beneath it. */
  ignored: string[]
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
/** Branches of the workspace's primary repo (local first, then remote-only). */
export interface GitBranches {
  is_repo: boolean
  current: string | null
  branches: BranchRef[]
}

/** One repo's outcome of a commit-push. A failed push after a successful
 *  commit reports `pushed: false` with `push_error` — the commit stands
 *  either way. */
export interface RepoCommitResult {
  /** Workspace-relative repo root ("" = the workspace root itself is the repo). */
  repo: string
  /** Short hash of the commit that landed. */
  commit_hash: string
  branch: string | null
  /** The message actually committed — composed by the backend's model when the
   *  caller supplies no override (which the panel never does). */
  message: string
  files_changed: number
  additions: number
  deletions: number
  pushed: boolean
  push_error: string | null
}

/** What a commit-push did: one entry per repo that had changes — a workspace
 *  can hold several repos in subdirectories, and clean repos are skipped. */
export interface CommitPushResult {
  commits: RepoCommitResult[]
}

export const gitApi = {
  diff: (workspaceId: string, signal?: AbortSignal) =>
    api.get<GitDiff>(`/workspaces/${workspaceId}/git/diff`, signal),
  status: (workspaceId: string, signal?: AbortSignal) =>
    api.get<GitStatus>(`/workspaces/${workspaceId}/git/status`, signal),
  branches: (workspaceId: string, signal?: AbortSignal) =>
    api.get<GitBranches>(`/workspaces/${workspaceId}/git/branches`, signal),
  checkout: (workspaceId: string, branch: string) =>
    api.post<GitBranches>(`/workspaces/${workspaceId}/git/checkout`, { branch }),
  commitPush: (workspaceId: string, message?: string, push = true) =>
    api.post<CommitPushResult>(`/workspaces/${workspaceId}/git/commit-push`, {
      message,
      push,
    }),
}

export const gitKeys = {
  diff: (workspaceId: string) => ["git", workspaceId, "diff"] as const,
  status: (workspaceId: string) => ["git", workspaceId, "status"] as const,
  branches: (workspaceId: string) => ["git", workspaceId, "branches"] as const,
}

/** Open a workspace's git-watch socket (state changes like commits, staging, and
 *  branch switches — see {@link useGitWatch}). */
export function connectGitWatchWs(workspaceId: string): WebSocket {
  return connectWs(`/workspaces/${workspaceId}/git/watch`)
}

/** Fetch the workspace's uncommitted diff (powers the Changes panel). */
export function useGitDiff(workspaceId: string | undefined) {
  return useQuery({
    queryKey: gitKeys.diff(workspaceId ?? ""),
    queryFn: ({ signal }) => gitApi.diff(workspaceId as string, signal),
    enabled: Boolean(workspaceId),
  })
}

/** Fetch a state per changed/ignored path (powers the file tree's decorations). */
export function useGitStatus(workspaceId: string | undefined) {
  return useQuery({
    queryKey: gitKeys.status(workspaceId ?? ""),
    queryFn: ({ signal }) => gitApi.status(workspaceId as string, signal),
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

/** Stage everything, commit, and (by default) push. A failed push after a
 *  successful commit is *not* a mutation error — the result reports it, so the
 *  panel can warn instead of lose the commit (see the endpoint's own note). */
export function useCommitAndPush(workspaceId: string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    // No message by default: the backend's model composes it from the diff.
    mutationFn: ({ message, push }: { message?: string; push?: boolean } = {}) =>
      gitApi.commitPush(workspaceId as string, message, push),
    onSuccess: () => {
      // The git-watch socket also refreshes, but invalidation is immediate.
      if (!workspaceId) return
      qc.invalidateQueries({ queryKey: gitKeys.diff(workspaceId) })
      qc.invalidateQueries({ queryKey: gitKeys.status(workspaceId) })
      qc.invalidateQueries({ queryKey: gitKeys.branches(workspaceId) })
    },
  })
}
