import { GitBranch, Lock, MagnifyingGlass } from "@phosphor-icons/react"
import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { toast } from "sonner"

import { useCloneRepo, useGitHubConfig, useGitHubRepos } from "@/api/github"
import type { GitHubRepo, Workspace } from "@/api/types"
import { Button } from "@/components/ui/button"
import { DotGridLoader } from "@/components/ui/dot-grid-loader"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

interface GitHubRepoPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  // Optional workspace name to use for the clone; falls back to the repo name.
  defaultName?: string
  // Called after a successful clone (e.g. to close the parent workspace dialog).
  onCloned?: (workspace: Workspace) => void
}

/**
 * Browse the connected GitHub account's repositories and clone one into a new
 * workspace. Cloning is what creates the workspace, so on success we navigate
 * straight into its chat.
 */
export function GitHubRepoPickerDialog({
  open,
  onOpenChange,
  defaultName,
  onCloned,
}: GitHubRepoPickerDialogProps) {
  const { data: config } = useGitHubConfig()
  const connected = Boolean(config?.connected)
  const {
    data,
    isLoading,
    isError,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useGitHubRepos(open && connected)
  const clone = useCloneRepo()
  const navigate = useNavigate()

  const [query, setQuery] = useState("")
  const [cloning, setCloning] = useState<string | null>(null)

  // Flatten the paginated pages into a single list. Search filters over the
  // repos loaded so far; scrolling to the bottom pulls the next page.
  const repos = useMemo(
    () => data?.pages.flat() ?? [],
    [data]
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return repos
    return repos.filter(
      (r) =>
        r.full_name.toLowerCase().includes(q) ||
        (r.description ?? "").toLowerCase().includes(q)
    )
  }, [repos, query])

  // Sentinel at the bottom of the list; loading the next page when it scrolls
  // into view keeps the initial render light for large accounts.
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const node = sentinelRef.current
    if (!node || !hasNextPage) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetchingNextPage) {
          void fetchNextPage()
        }
      },
      { root: node.parentElement, rootMargin: "200px" }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, filtered.length])

  async function handleClone(repo: GitHubRepo) {
    setCloning(repo.full_name)
    try {
      const ws = await clone.mutateAsync({
        repo_full_name: repo.full_name,
        name: defaultName?.trim() || undefined,
      })
      toast.success(`Cloned into "${ws.name}"`)
      onOpenChange(false)
      onCloned?.(ws)
      navigate(`/workspaces/${ws.id}/chat`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Clone failed")
    } finally {
      setCloning(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-lg flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Clone from GitHub</DialogTitle>
          <DialogDescription>
            Pick a repository to clone into a new workspace.
          </DialogDescription>
        </DialogHeader>

        {!connected ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border/70 bg-muted/20 p-8 text-center">
            <p className="text-sm text-muted-foreground">
              Connect a GitHub account to browse your repositories.
            </p>
            <Button asChild variant="secondary" onClick={() => onOpenChange(false)}>
              <Link to="/settings?tab=general">Connect GitHub</Link>
            </Button>
          </div>
        ) : (
          <>
            <div className="relative">
              <MagnifyingGlass className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="Search repositories…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>

            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
              {isLoading ? (
                <p className="text-sm text-muted-foreground">
                  Loading repositories…
                </p>
              ) : isError ? (
                <p className="text-sm text-destructive">
                  {error instanceof Error
                    ? error.message
                    : "Failed to load repositories"}
                </p>
              ) : filtered.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {repos && repos.length > 0
                    ? "No matching repositories."
                    : "No repositories found for this account."}
                </p>
              ) : (
                filtered.map((repo) => (
                  <button
                    key={repo.full_name}
                    type="button"
                    disabled={cloning !== null}
                    onClick={() => void handleClone(repo)}
                    className="flex w-full items-center justify-between gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:bg-accent disabled:opacity-60"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium text-foreground">
                          {repo.full_name}
                        </span>
                        {repo.private ? (
                          <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />
                        ) : null}
                      </div>
                      {repo.description ? (
                        <p className="truncate text-xs text-muted-foreground">
                          {repo.description}
                        </p>
                      ) : null}
                    </div>
                    {cloning === repo.full_name ? (
                      <DotGridLoader size="xs" className="shrink-0" />
                    ) : (
                      <GitBranch className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                  </button>
                ))
              )}

              {/* Infinite-scroll trigger + spinner for the next page. Only
                  active when not filtering, since search runs over loaded
                  repos and shouldn't keep paging in the background. */}
              {!query.trim() && hasNextPage ? (
                <div ref={sentinelRef} className="flex justify-center py-2">
                  {isFetchingNextPage ? (
                    <DotGridLoader size="xs" />
                  ) : null}
                </div>
              ) : null}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
