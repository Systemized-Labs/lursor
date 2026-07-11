import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { api } from "./client"
import { workspaceKeys } from "./workspaces"
import type {
  GitHubCloneInput,
  GitHubConfig,
  GitHubConfigInput,
  GitHubRepo,
  Workspace,
} from "./types"

export const githubApi = {
  config: (signal?: AbortSignal) => api.get<GitHubConfig>("/github/config", signal),
  save: (input: GitHubConfigInput) => api.put<GitHubConfig>("/github/config", input),
  disconnect: () => api.delete<void>("/github/config"),
  repos: (signal?: AbortSignal) => api.get<GitHubRepo[]>("/github/repos", signal),
  clone: (input: GitHubCloneInput) => api.post<Workspace>("/github/clone", input),
}

export const githubKeys = {
  config: ["github", "config"] as const,
  repos: ["github", "repos"] as const,
}

export function useGitHubConfig() {
  return useQuery({
    queryKey: githubKeys.config,
    queryFn: ({ signal }) => githubApi.config(signal),
  })
}

export function useSaveGitHubConfig() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: GitHubConfigInput) => githubApi.save(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: githubKeys.config })
      qc.invalidateQueries({ queryKey: githubKeys.repos })
    },
  })
}

export function useDisconnectGitHub() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => githubApi.disconnect(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: githubKeys.config })
      qc.removeQueries({ queryKey: githubKeys.repos })
    },
  })
}

// Repos are fetched from GitHub on demand — only while a connection exists, and
// not refetched on window focus (each call hits the GitHub API and counts
// against the token's rate limit).
export function useGitHubRepos(enabled: boolean) {
  return useQuery({
    queryKey: githubKeys.repos,
    queryFn: ({ signal }) => githubApi.repos(signal),
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  })
}

// Cloning creates a new workspace, so refresh the workspace list on success.
export function useCloneRepo() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: GitHubCloneInput) => githubApi.clone(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: workspaceKeys.all }),
  })
}
