import { useCallback } from "react"
import { CircleNotch } from "@phosphor-icons/react"
import { useQuery, useQueryClient } from "@tanstack/react-query"

import { fileKeys, filesApi, type FileChange } from "@/api/files"
import { MarkdownRenderer } from "@/components/ui/markdown-renderer"
import { useFileWatch } from "@/hooks/use-file-watch"

interface MobilePlanViewProps {
  workspaceId: string
  /**
   * Workspace-relative path to the plan doc, e.g. `.agents/plan/PLAN-x.md`.
   * Undefined until a `/plan` turn parks one — the view shows a prompt to
   * create one in that case.
   */
  path?: string
}

/**
 * A phone-friendly, read-only view of a plan doc. Monaco (the desktop file
 * editor) isn't workable on a phone, and a parked `/plan` turn is meant to be
 * *read* before you approve or refine it — so on mobile we render the plan's
 * Markdown in a scrollable reading column instead of mounting the editor.
 *
 * The doc live-refreshes: when a `/plan` refinement rewrites the file on disk,
 * the workspace file-watch stream invalidates this query and the new plan shows.
 */
export function MobilePlanView({ workspaceId, path }: MobilePlanViewProps) {
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: fileKeys.file(workspaceId, path ?? ""),
    queryFn: ({ signal }) => filesApi.read(workspaceId, path as string, signal),
    enabled: Boolean(path),
  })

  // Refetch when the agent rewrites the plan (e.g. a `/plan` refinement).
  useFileWatch(
    workspaceId,
    useCallback(
      (changes: FileChange[]) => {
        if (path && changes.some((c) => c.path === path)) {
          void qc.invalidateQueries({
            queryKey: fileKeys.file(workspaceId, path),
          })
        }
      },
      [qc, workspaceId, path]
    )
  )

  const content = query.data?.content ?? ""

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-card">
      <div className="flex-1 overflow-auto px-4 py-5 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto w-full max-w-3xl">
          {!path ? (
            <p className="text-sm text-muted-foreground">
              No plan yet. Send <code>/plan &lt;what to build&gt;</code> in the
              chat to draft one, and it'll show up here to review.
            </p>
          ) : query.isLoading ? (
            <div className="flex items-center justify-center py-10">
              <CircleNotch className="h-5 w-5 animate-spin text-muted-foreground motion-reduce:animate-none" />
            </div>
          ) : query.isError ? (
            <p className="text-sm text-destructive">
              Couldn't load the plan doc.
            </p>
          ) : content.trim() ? (
            <MarkdownRenderer>{content}</MarkdownRenderer>
          ) : (
            <p className="text-sm text-muted-foreground">
              This plan is empty.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
