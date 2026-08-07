import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"

import { api } from "./client"
import { workspaceKeys } from "./workspaces"
import type {
  GitHubCloneInput,
  GitHubCloneIntoInput,
  GitHubCloneIntoResult,
  GitHubConfig,
  GitHubConfigInput,
  GitHubRepo,
  GitHubTokenReveal,
  Workspace,
} from "./types"

export const githubApi = {
  config: (signal?: AbortSignal) => api.get<GitHubConfig>("/github/config", signal),
  // Fetched on demand (never cached) so the raw token only crosses the wire
  // when the user explicitly asks to copy it.
  revealToken: () => api.get<GitHubTokenReveal>("/github/config/token"),
  save: (input: GitHubConfigInput) => api.put<GitHubConfig>("/github/config", input),
  disconnect: () => api.delete<void>("/github/config"),
  repos: (page: number, perPage: number, signal?: AbortSignal) =>
    api.get<GitHubRepo[]>(
      `/github/repos?page=${page}&per_page=${perPage}`,
      signal
    ),
  clone: (input: GitHubCloneInput) => api.post<Workspace>("/github/clone", input),
  cloneInto: (workspaceId: string, input: GitHubCloneIntoInput) =>
    api.post<GitHubCloneIntoResult>(
      `/github/clone-into/${workspaceId}`,
      input
    ),
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

export const REPOS_PAGE_SIZE = 30

// Repos are fetched from GitHub on demand — only while a connection exists, and
// not refetched on window focus (each call hits the GitHub API and counts
// against the token's rate limit). Paginated so a large account loads a page at
// a time (infinite scroll) rather than all repos up front.
export function useGitHubRepos(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: githubKeys.repos,
    queryFn: ({ pageParam, signal }) =>
      githubApi.repos(pageParam, REPOS_PAGE_SIZE, signal),
    initialPageParam: 1,
    // A short (non-full) page means GitHub has no more repos to give.
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length === REPOS_PAGE_SIZE ? allPages.length + 1 : undefined,
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

// Cloning into an existing workspace drops the repo into a subfolder; the
// workspace itself is unchanged, so there's no cache to invalidate.
export function useCloneRepoInto(workspaceId: string) {
  return useMutation({
    mutationFn: (input: GitHubCloneIntoInput) =>
      githubApi.cloneInto(workspaceId, input),
  })
}
