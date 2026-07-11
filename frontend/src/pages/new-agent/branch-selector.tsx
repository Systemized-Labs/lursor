import { useEffect, useMemo, useRef, useState } from "react"
import { Check, CaretDown, GitBranch, MagnifyingGlass } from "@phosphor-icons/react"
import { toast } from "sonner"

import { useBranches, useCheckoutBranch } from "@/api/git"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

interface BranchSelectorProps {
  workspaceId: string
}

/**
 * A searchable branch picker for the New Agent surface: shows the primary
 * repo's current branch, and switching selects (checks out) another local
 * branch. Hidden entirely when the workspace isn't a git repo.
 */
export function BranchSelector({ workspaceId }: BranchSelectorProps) {
  const branchesQuery = useBranches(workspaceId)
  const checkout = useCheckoutBranch(workspaceId)

  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const data = branchesQuery.data
  const current = data?.current ?? null
  const branches = useMemo(() => data?.branches ?? [], [data?.branches])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return branches
    return branches.filter((b) => {
      const full = b.remote ? `${b.remote}/${b.name}` : b.name
      return full.toLowerCase().includes(q)
    })
  }, [branches, search])

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  useEffect(() => {
    if (open) {
      setSearch("")
      const id = setTimeout(() => searchRef.current?.focus(), 40)
      return () => clearTimeout(id)
    }
  }, [open])

  async function selectBranch(branch: string) {
    setOpen(false)
    if (branch === current) return
    try {
      await checkout.mutateAsync(branch)
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : `Failed to switch to ${branch}`
      )
    }
  }

  // Not a repo (or still loading with nothing yet) — render nothing.
  if (branchesQuery.isSuccess && !data?.is_repo) return null
  if (!current && branches.length === 0) return null

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={checkout.isPending}
        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
      >
        <GitBranch className="size-3.5" />
        <span className="max-w-[12rem] truncate">{current ?? "branch"}</span>
        <CaretDown className="size-3.5" />
      </button>

      {open ? (
        <div className="absolute left-0 top-full z-50 mt-1 w-72 overflow-hidden rounded-xl border border-border/60 bg-popover shadow-lg">
          <div className="border-b border-border/60 p-1.5">
            <div className="flex h-8 items-center gap-2 rounded-lg bg-muted/60 px-2 focus-within:bg-background">
              <MagnifyingGlass className="size-3.5 shrink-0 text-muted-foreground" />
              <input
                ref={searchRef}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search branches..."
                className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
          </div>
          <ScrollArea className="max-h-72">
            <div className="p-1">
              {branchesQuery.isLoading ? (
                <p className="px-2 py-2 text-sm text-muted-foreground">
                  Loading…
                </p>
              ) : filtered.length === 0 ? (
                <p className="px-2 py-2 text-sm text-muted-foreground">
                  No branches found.
                </p>
              ) : (
                filtered.map((branch) => {
                  const isCurrent = !branch.remote && branch.name === current
                  const key = branch.remote
                    ? `${branch.remote}/${branch.name}`
                    : branch.name
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => void selectBranch(branch.name)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                        "text-foreground hover:bg-muted/60"
                      )}
                    >
                      <span className="flex-1 truncate">{branch.name}</span>
                      {isCurrent ? (
                        <Check className="size-4 shrink-0 text-foreground" />
                      ) : null}
                    </button>
                  )
                })
              )}
            </div>
          </ScrollArea>
        </div>
      ) : null}
    </div>
  )
}
