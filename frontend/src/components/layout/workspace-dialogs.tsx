import { useEffect, useState, type ReactNode } from "react"
import { useNavigate } from "react-router-dom"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  invalidateThreadLists,
  threadKeys,
  threadsApi,
  useUpdateThread,
} from "@/api/threads"
import { useDeleteWorkspace, useUpdateWorkspace } from "@/api/workspaces"
import type { Thread, Workspace } from "@/api/types"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { RenameDialog } from "@/components/layout/rename-dialog"
import { CloneIntoWorkspaceDialog } from "@/pages/workspaces/clone-into-workspace-dialog"
import { WorkspaceFormDialog } from "@/pages/workspaces/workspace-form-dialog"
import type { SidebarSelection } from "@/components/layout/use-sidebar-selection"

/** Minimal identity of a workspace a dialog is acting on. */
interface WorkspaceTarget {
  id: string
  name: string
}

interface UseWorkspaceDialogsOptions {
  selection: SidebarSelection
  activeWorkspaceId: string | undefined
  activeThreadId: string | null
}

export interface WorkspaceDialogs {
  /** Render once, anywhere inside the sidebar. */
  dialogs: ReactNode
  openNewWorkspace: () => void
  openRenameThread: (thread: Thread) => void
  openDeleteThread: (thread: Thread) => void
  openRenameWorkspace: (workspace: Workspace) => void
  openDeleteWorkspace: (workspace: Workspace) => void
  openCloneWorkspace: (workspace: Workspace) => void
  openBulkDelete: () => void
}

/**
 * Every destructive/renaming dialog the sidebar owns, plus the mutations behind
 * them, in one place. Extracted from the sidebar so the navigation components
 * stay about navigation — the dialogs were roughly a sixth of the old file and
 * had nothing to do with layout.
 */
export function useWorkspaceDialogs({
  selection,
  activeWorkspaceId,
  activeThreadId,
}: UseWorkspaceDialogsOptions): WorkspaceDialogs {
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [workspaceFormOpen, setWorkspaceFormOpen] = useState(false)
  const [renameTarget, setRenameTarget] = useState<Thread | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Thread | null>(null)
  const [renameWsTarget, setRenameWsTarget] = useState<WorkspaceTarget | null>(
    null
  )
  const [deleteWsTarget, setDeleteWsTarget] = useState<WorkspaceTarget | null>(
    null
  )
  const [cloneWsTarget, setCloneWsTarget] = useState<WorkspaceTarget | null>(
    null
  )
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)

  const updateThread = useUpdateThread()
  const deleteThread = useMutation({
    mutationFn: (thread: Thread) => threadsApi.remove(thread.id),
    onSuccess: (_data, thread) =>
      invalidateThreadLists(qc, thread.workspace_id),
  })
  const updateWorkspace = useUpdateWorkspace()
  const deleteWorkspace = useDeleteWorkspace()

  // Esc leaves bulk selection (unless the confirm dialog owns Esc).
  useEffect(() => {
    if (selection.count === 0 || bulkDeleteOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") selection.clear()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [selection, bulkDeleteOpen])

  async function handleRename(value: string) {
    if (!renameTarget) return
    const title = value.trim()
    if (!title) return
    try {
      await updateThread.mutateAsync({ id: renameTarget.id, input: { title } })
      setRenameTarget(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to rename")
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    const thread = deleteTarget
    try {
      await deleteThread.mutateAsync(thread)
      setDeleteTarget(null)
      // If the open conversation was deleted, fall back to a new one.
      if (activeThreadId === thread.id) {
        navigate(`/workspaces/${thread.workspace_id}/chat`)
      }
      toast.success("Conversation deleted")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete")
    }
  }

  async function handleRenameWorkspace(value: string) {
    if (!renameWsTarget) return
    const name = value.trim()
    if (!name) return
    try {
      await updateWorkspace.mutateAsync({
        id: renameWsTarget.id,
        input: { name },
      })
      setRenameWsTarget(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to rename")
    }
  }

  function handleDeleteWorkspace() {
    if (!deleteWsTarget) return
    const ws = deleteWsTarget
    // Close the dialog and update the UI immediately; the delete runs in the
    // background with an optimistic cache update (rolled back on failure).
    setDeleteWsTarget(null)
    if (activeWorkspaceId === ws.id) {
      navigate("/customization")
    }
    deleteWorkspace.mutate(ws.id, {
      onSuccess: () => {
        // Its conversations went with it — the cross-workspace lists hold them
        // too, and nothing else invalidates those.
        invalidateThreadLists(qc, ws.id)
        toast.success("Workspace deleted")
      },
      onError: (err) =>
        toast.error(err instanceof Error ? err.message : "Failed to delete"),
    })
  }

  function handleBulkDelete() {
    // Close the dialog and update the UI immediately; the deletes run in the
    // background with an optimistic cache update (rolled back on failure).
    const threads = [...selection.threads.values()]
    if (threads.length === 0) return
    const openDeleted = threads.find((t) => t.id === activeThreadId)
    if (openDeleted) {
      navigate(`/workspaces/${openDeleted.workspace_id}/chat`)
    }
    const ids = new Set(threads.map((t) => t.id))
    const affected = [...new Set(threads.map((t) => t.workspace_id))]
    // Both cache shapes hold these rows: the per-workspace lists the panel reads,
    // and the cross-workspace list Activity and the rail's status marks read. Drop
    // them from every one, or the deleted conversations linger in the panel.
    const previous = affected.map((wsId) => ({
      wsId,
      data: qc.getQueryData<Thread[]>(threadKeys.byWorkspace(wsId)),
    }))
    const previousAll = qc.getQueryData<Thread[]>(threadKeys.crossWorkspace())
    const drop = (old: Thread[] | undefined) =>
      (old ?? []).filter((t) => !ids.has(t.id))
    for (const wsId of affected) {
      qc.setQueryData<Thread[]>(threadKeys.byWorkspace(wsId), drop)
    }
    qc.setQueryData<Thread[]>(threadKeys.crossWorkspace(), drop)
    selection.clear()
    setBulkDeleteOpen(false)
    Promise.all(threads.map((t) => threadsApi.remove(t.id)))
      .then(() => {
        toast.success(
          `${threads.length} conversation${threads.length > 1 ? "s" : ""} deleted`
        )
      })
      .catch((err) => {
        for (const { wsId, data } of previous) {
          if (data) qc.setQueryData(threadKeys.byWorkspace(wsId), data)
        }
        if (previousAll) qc.setQueryData(threadKeys.crossWorkspace(), previousAll)
        toast.error(err instanceof Error ? err.message : "Failed to delete")
      })
      .finally(() => {
        for (const wsId of affected) invalidateThreadLists(qc, wsId)
      })
  }

  const dialogs = (
    <>
      <WorkspaceFormDialog
        open={workspaceFormOpen}
        onOpenChange={setWorkspaceFormOpen}
      />

      <RenameDialog
        title="Rename conversation"
        initialValue={renameTarget?.title ?? ""}
        open={Boolean(renameTarget)}
        pending={updateThread.isPending}
        onCancel={() => setRenameTarget(null)}
        onSave={(v) => void handleRename(v)}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete conversation"
        description={
          deleteTarget
            ? `This will permanently delete "${deleteTarget.title || "this conversation"}".`
            : undefined
        }
        confirmLabel="Delete"
        destructive
        loading={deleteThread.isPending}
        onConfirm={handleDelete}
      />

      <RenameDialog
        title="Rename workspace"
        initialValue={renameWsTarget?.name ?? ""}
        open={Boolean(renameWsTarget)}
        pending={updateWorkspace.isPending}
        onCancel={() => setRenameWsTarget(null)}
        onSave={(v) => void handleRenameWorkspace(v)}
      />

      <ConfirmDialog
        open={Boolean(deleteWsTarget)}
        onOpenChange={(open) => !open && setDeleteWsTarget(null)}
        title="Delete workspace"
        description={
          deleteWsTarget
            ? `This will permanently delete "${deleteWsTarget.name || "this workspace"}" and all of its conversations.`
            : undefined
        }
        confirmLabel="Delete"
        destructive
        onConfirm={handleDeleteWorkspace}
      />

      <ConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={(open) => !open && setBulkDeleteOpen(false)}
        title="Delete conversations"
        description={`This will permanently delete ${selection.count} conversation${
          selection.count > 1 ? "s" : ""
        }.`}
        confirmLabel="Delete"
        destructive
        onConfirm={handleBulkDelete}
      />

      {cloneWsTarget ? (
        <CloneIntoWorkspaceDialog
          open={Boolean(cloneWsTarget)}
          onOpenChange={(open) => !open && setCloneWsTarget(null)}
          workspaceId={cloneWsTarget.id}
          workspaceName={cloneWsTarget.name}
        />
      ) : null}
    </>
  )

  return {
    dialogs,
    openNewWorkspace: () => setWorkspaceFormOpen(true),
    openRenameThread: setRenameTarget,
    openDeleteThread: setDeleteTarget,
    openRenameWorkspace: (ws) => setRenameWsTarget({ id: ws.id, name: ws.name }),
    openDeleteWorkspace: (ws) => setDeleteWsTarget({ id: ws.id, name: ws.name }),
    openCloneWorkspace: (ws) => setCloneWsTarget({ id: ws.id, name: ws.name }),
    openBulkDelete: () => setBulkDeleteOpen(true),
  }
}
