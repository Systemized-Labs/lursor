import { useCallback, useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { GitBranch, FolderOpen } from "@phosphor-icons/react"
import { toast } from "sonner"

import type { Workspace, WorkspaceInput } from "@/api/types"
import { useCreateWorkspace, useUpdateWorkspace } from "@/api/workspaces"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/responsive-dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { GitHubRepoPickerDialog } from "./github-repo-picker-dialog"
import { useFolderPicker } from "./use-folder-picker"

interface FormState {
  name: string
  description: string
  path: string
}

const EMPTY: FormState = { name: "", description: "", path: "" }

interface WorkspaceFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspace?: Workspace
}

export function WorkspaceFormDialog({
  open,
  onOpenChange,
  workspace,
}: WorkspaceFormDialogProps) {
  const navigate = useNavigate()
  const [form, setForm] = useState<FormState>(EMPTY)
  const [repoPickerOpen, setRepoPickerOpen] = useState(false)
  const createWorkspace = useCreateWorkspace()
  const updateWorkspace = useUpdateWorkspace()
  const isEdit = Boolean(workspace)
  const isSaving = createWorkspace.isPending || updateWorkspace.isPending

  const applyPickedPath = useCallback((path: string) => {
    const folderName = path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? ""
    setForm((prev) => ({
      ...prev,
      path,
      name: prev.name.trim() ? prev.name : folderName,
    }))
  }, [])

  const {
    browse: handleBrowse,
    browsing: isBrowsing,
    dialog: folderBrowser,
  } = useFolderPicker(applyPickedPath)

  useEffect(() => {
    if (open) {
      setForm(
        workspace
          ? {
              name: workspace.name,
              description: workspace.description,
              path: workspace.path,
            }
          : EMPTY
      )
    }
  }, [open, workspace])

  async function handleSubmit() {
    if (!form.name.trim()) {
      toast.error("Name is required")
      return
    }
    const input: WorkspaceInput = {
      name: form.name.trim(),
      description: form.description.trim(),
      path: form.path.trim() || undefined,
    }
    try {
      if (workspace) {
        await updateWorkspace.mutateAsync({ id: workspace.id, input })
        toast.success("Workspace updated")
      } else {
        const created = await createWorkspace.mutateAsync(input)
        toast.success("Workspace created")
        onOpenChange(false)
        navigate(`/workspaces/${created.id}/chat`)
        return
      }
      onOpenChange(false)
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to save workspace"
      )
    }
  }

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit workspace" : "New workspace"}
          </DialogTitle>
          <DialogDescription>
            A workspace is a directory on disk that hosts chat threads.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          {!isEdit ? (
            <>
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => setRepoPickerOpen(true)}
              >
                <GitBranch className="h-4 w-4" />
                Clone from GitHub
              </Button>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                or create an empty workspace
                <span className="h-px flex-1 bg-border" />
              </div>
            </>
          ) : null}
          <div className="grid gap-2">
            <Label htmlFor="workspace-name">Name</Label>
            <Input
              id="workspace-name"
              value={form.name}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, name: e.target.value }))
              }
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="workspace-description">Description</Label>
            <Input
              id="workspace-description"
              value={form.description}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, description: e.target.value }))
              }
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="workspace-path">Folder location</Label>
            <div className="flex gap-2">
              <Input
                id="workspace-path"
                className="flex-1"
                value={form.path}
                placeholder="~/.lursor/workspaces/{id}"
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, path: e.target.value }))
                }
              />
              <Button
                type="button"
                variant="outline"
                onClick={handleBrowse}
                disabled={isBrowsing}
              >
                <FolderOpen />
                {isBrowsing ? "Opening…" : "Browse"}
              </Button>
            </div>
            <p className="text-sm text-muted-foreground">
              Absolute path to the workspace directory. Leave blank to use the
              default location.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isSaving}>
            {isEdit ? "Save changes" : "Create workspace"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <GitHubRepoPickerDialog
      open={repoPickerOpen}
      onOpenChange={setRepoPickerOpen}
      defaultName={form.name}
      onCloned={() => onOpenChange(false)}
    />
    {folderBrowser}
    </>
  )
}
