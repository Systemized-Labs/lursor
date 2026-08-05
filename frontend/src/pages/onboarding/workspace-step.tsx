import { FolderOpen, GitBranch } from "@phosphor-icons/react"
import { useCallback, useState } from "react"
import { toast } from "sonner"

import type { Workspace } from "@/api/types"
import { useCreateWorkspace } from "@/api/workspaces"
import { Button } from "@/components/ui/button"
import { DotGridLoader } from "@/components/ui/dot-grid-loader"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { GitHubRepoPickerDialog } from "@/pages/workspaces/github-repo-picker-dialog"
import { useFolderPicker } from "@/pages/workspaces/use-folder-picker"

interface WorkspaceStepProps {
  /** Whether the clone route is available (set in the previous step). */
  githubReady: boolean
  onCreated: (workspace: Workspace) => void
}

/**
 * Step three: the first workspace — a real directory on disk that agents are
 * rooted in. Two ways in: clone a repo (when GitHub is connected) or point at a
 * folder you already have. Naming one without a path is allowed too; the backend
 * materializes it under `~/.lursor/workspaces`.
 *
 * Deliberately not the shared WorkspaceFormDialog: that one navigates straight
 * into the new workspace's chat on save, which would skip the last step of the
 * walkthrough.
 */
export function WorkspaceStep({ githubReady, onCreated }: WorkspaceStepProps) {
  const create = useCreateWorkspace()
  const [name, setName] = useState("")
  const [path, setPath] = useState("")
  const [pickerOpen, setPickerOpen] = useState(false)

  const applyPickedPath = useCallback((picked: string) => {
    const folder = picked.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? ""
    setPath(picked)
    // Only fill the name if the user hasn't typed one — the folder is a good
    // default, not an override.
    setName((prev) => (prev.trim() ? prev : folder))
  }, [])

  const { browse: handleBrowse, browsing, dialog: folderBrowser } =
    useFolderPicker(applyPickedPath)

  async function handleCreate() {
    const trimmed = name.trim()
    if (!trimmed) return
    try {
      const ws = await create.mutateAsync({
        name: trimmed,
        description: "",
        path: path.trim() || undefined,
      })
      // No toast: advancing to the last step (which names the workspace) is the
      // confirmation, and a toast would land on top of the button that finishes.
      onCreated(ws)
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to create the workspace"
      )
    }
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">
          Open your first workspace
        </h2>
        <p className="text-sm text-muted-foreground">
          A workspace is a folder on your disk. Every conversation runs there,
          with a terminal, file tree, and git diff beside it.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Button
          type="button"
          variant="outline"
          className="h-auto flex-col items-start gap-1 px-4 py-3 text-left"
          disabled={!githubReady}
          onClick={() => setPickerOpen(true)}
        >
          <span className="flex items-center gap-2 text-sm font-medium text-foreground">
            <GitBranch className="size-4" />
            Clone a repo
          </span>
          <span className="text-xs font-normal text-muted-foreground">
            {githubReady
              ? "Pick from your GitHub account"
              : "Connect GitHub first"}
          </span>
        </Button>

        <Button
          type="button"
          variant="outline"
          className="h-auto flex-col items-start gap-1 px-4 py-3 text-left"
          disabled={browsing}
          onClick={handleBrowse}
        >
          <span className="flex items-center gap-2 text-sm font-medium text-foreground">
            {browsing ? (
              <DotGridLoader size="xs" />
            ) : (
              <FolderOpen className="size-4" />
            )}
            Choose a folder
          </span>
          <span className="text-xs font-normal text-muted-foreground">
            Use a project already on this machine
          </span>
        </Button>
      </div>

      <div className="grid gap-4 border-t border-border pt-4">
        <div className="grid gap-2">
          <Label htmlFor="onboarding-ws-name">Name</Label>
          <Input
            id="onboarding-ws-name"
            placeholder="my-project"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="onboarding-ws-path">Folder</Label>
          <Input
            id="onboarding-ws-path"
            className="font-mono text-sm"
            spellCheck={false}
            placeholder="~/.lursor/workspaces/{name}"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Leave blank and Lursor creates an empty folder in its own directory.
          </p>
        </div>
        <div className="flex justify-end">
          <Button
            onClick={handleCreate}
            disabled={create.isPending || !name.trim()}
          >
            {create.isPending ? <DotGridLoader size="xs" /> : null}
            Create workspace
          </Button>
        </div>
      </div>

      <GitHubRepoPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        defaultName={name}
        // Stay on the walkthrough after cloning so the last step still runs.
        navigateOnClone={false}
        onCloned={onCreated}
      />
      {folderBrowser}
    </div>
  )
}
