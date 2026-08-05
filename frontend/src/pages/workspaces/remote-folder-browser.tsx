import { CaretUp, Eye, EyeSlash, Folder, GitBranch, House } from "@phosphor-icons/react"
import { useEffect, useState } from "react"

import { useDirListing } from "@/api/fs"
import { Button } from "@/components/ui/button"
import { DotGridLoader } from "@/components/ui/dot-grid-loader"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/responsive-dialog"
import { Input } from "@/components/ui/input"

interface RemoteFolderBrowserProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called with the chosen absolute path on the backend host. */
  onPick: (path: string) => void
}

/**
 * Choose a directory on the machine the backend runs on.
 *
 * Stands in for the native OS folder dialog when there isn't one to show — a
 * backend on a VPS is headless, so `POST /workspaces/pick-folder` has no display to
 * draw on and no desktop session to belong to. This walks the remote filesystem over
 * `GET /api/fs/dirs` instead.
 *
 * Two things it does that a native dialog gets for free, and which are the reason
 * this is worth its own component rather than a list of paths: it marks directories
 * that are git repositories, which is what you are usually looking for, and it lets
 * a path be typed directly — far faster than clicking down eight levels of a remote
 * filesystem you already know the layout of.
 */
export function RemoteFolderBrowser({
  open,
  onOpenChange,
  onPick,
}: RemoteFolderBrowserProps) {
  // Empty string means "wherever the backend calls home", which it resolves.
  const [path, setPath] = useState("")
  const [showHidden, setShowHidden] = useState(false)
  const [typed, setTyped] = useState("")

  const { data, isLoading, isError, error } = useDirListing(path, showHidden, open)

  // Reset to home each time the dialog opens: the last place browsed is rarely
  // where the next workspace lives, and a stale path that has since been deleted
  // would open on an error.
  useEffect(() => {
    if (open) {
      setPath("")
      setTyped("")
    }
  }, [open])

  // Follow the resolved path into the address field, so what is shown is always
  // where we actually are (the backend expands `~` and collapses `..`).
  useEffect(() => {
    if (data?.path) setTyped(data.path)
  }, [data?.path])

  const current = data?.path ?? ""

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Choose a folder</DialogTitle>
          <DialogDescription>
            Directories on the machine running the backend. Type a path or browse to
            one.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            title="Home"
            onClick={() => setPath("")}
          >
            <House className="size-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            title="Up one level"
            disabled={!data?.parent}
            onClick={() => data?.parent && setPath(data.parent)}
          >
            <CaretUp className="size-4" />
          </Button>
          <form
            className="flex-1"
            onSubmit={(e) => {
              e.preventDefault()
              if (typed.trim()) setPath(typed.trim())
            }}
          >
            <Input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              spellCheck={false}
              placeholder="/srv/projects"
              aria-label="Path"
            />
          </form>
          <Button
            type="button"
            variant="outline"
            size="icon"
            title={showHidden ? "Hide dotfolders" : "Show dotfolders"}
            onClick={() => setShowHidden((v) => !v)}
          >
            {showHidden ? (
              <EyeSlash className="size-4" />
            ) : (
              <Eye className="size-4" />
            )}
          </Button>
        </div>

        <div className="h-72 overflow-y-auto rounded-md border border-border">
          {isLoading ? (
            <div className="flex h-full items-center justify-center">
              <DotGridLoader />
            </div>
          ) : isError ? (
            <p className="p-4 text-sm text-muted-foreground">
              {error instanceof Error ? error.message : "Could not read that folder."}
            </p>
          ) : data && data.entries.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              No subfolders here. You can still choose this folder.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {data?.entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground hover:bg-accent"
                    // Single click descends; the footer button chooses. A folder you
                    // want is usually one you also want to look inside first.
                    onClick={() => setPath(entry.path)}
                    onDoubleClick={() => {
                      onPick(entry.path)
                      onOpenChange(false)
                    }}
                  >
                    {entry.is_repo ? (
                      <GitBranch className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <Folder className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate">{entry.name}</span>
                    {entry.is_repo && (
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        repo
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {data?.truncated && (
          <p className="text-xs text-muted-foreground">
            This folder has more subfolders than are shown. Type a path to reach one
            that isn't listed.
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!current}
            onClick={() => {
              onPick(current)
              onOpenChange(false)
            }}
          >
            Use this folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
