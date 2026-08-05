import { useEffect, useMemo, useState } from "react"
import { FileText, FilmSlate, ImageSquare, Stack } from "@phosphor-icons/react"

import { useLaiosConnections } from "@/api/laios"
import { imageContentUrl, useImageRuns } from "@/api/images"
import { videoContentUrl, useVideoJobs } from "@/api/videos"
import { useAllThreads } from "@/hooks/use-all-threads"
import { requestOpenFile } from "@/lib/open-file"
import { requestOpenThread } from "@/lib/open-thread"
import { timeAgo } from "@/lib/time-ago"
import { cn } from "@/lib/utils"

/** Shared with the LAIOS, Video and Image surfaces. */
const ACTIVE_CONNECTION_KEY = "laios.activeConnectionId"

type Tab = "plans" | "media"

interface ArtifactsPaneProps {
  /** Scopes the plan-doc list; media is LAIOS-scoped and ignores it. */
  workspaceId?: string
  /** Ask the shell to open a pane of some kind — how "open in Video" works. */
  onOpenPane?: (kind: "video" | "image") => void
}

/**
 * What the agents have produced: plan docs, and generated video and images.
 *
 * The *index*, not the workshop. Video and Image have their own panes for
 * submitting and watching a run; this is the place you come back to when you want
 * the thing that came out, and it links across rather than duplicating the
 * composers.
 *
 * Open question 3 was resolved to the wide reading — video and image output *and*
 * plan docs *and* agent-written files. Three of those four are here. The fourth is
 * not, and the reason is worth stating rather than quietly shipping half of it:
 *
 * **Agent-written files need a backend endpoint.** The provenance exists — a
 * write shows up as a `write_file` / `hashline_edit` tool call, and
 * `ThreadMessage.tool_calls` is persisted, so `agui/file-changes.ts` already
 * derives exactly this list for a single turn. What does not exist is a way to ask
 * "every file this workspace's agents have written", which today would mean
 * fetching the messages of every thread in the workspace and scanning them client
 * side: N requests, and a list whose contents depend on which conversations you
 * happen to have opened. That is worse than not having the section, because it
 * looks complete and is not. The honest version is a
 * `GET /workspaces/{id}/artifacts` that scans server-side; until then this pane
 * says what it covers.
 */
export function ArtifactsPane({ workspaceId, onOpenPane }: ArtifactsPaneProps) {
  const [tab, setTab] = useState<Tab>("plans")
  const threads = useAllThreads()
  const { data: connections } = useLaiosConnections()

  const [connectionId, setConnectionId] = useState<string | undefined>(() =>
    typeof window === "undefined"
      ? undefined
      : (localStorage.getItem(ACTIVE_CONNECTION_KEY) ?? undefined)
  )
  // Keep the selection valid as connections load or change — the same guard the
  // Video and Image pages use, for the same reason.
  useEffect(() => {
    if (!connections) return
    if (!connections.some((c) => c.id === connectionId)) {
      setConnectionId(connections[0]?.id)
    }
  }, [connections, connectionId])

  const { data: videoJobs } = useVideoJobs(connectionId)
  const { data: imageRuns } = useImageRuns(connectionId)

  /**
   * Plan docs, newest first.
   *
   * Read off `Thread.plan_path`, which the goal driver already sets — so this
   * costs nothing beyond the cross-workspace thread list the sidebar is holding
   * anyway. Scoped to the workspace when there is one; a global Artifacts pane
   * shows every workspace's, labelled.
   */
  const plans = useMemo(() => {
    const rows = threads.threads.filter((thread) => Boolean(thread.plan_path))
    const scoped = workspaceId
      ? rows.filter((thread) => thread.workspace_id === workspaceId)
      : rows
    return scoped.map((thread) => ({
      thread,
      name: thread.plan_path.split("/").pop() ?? thread.plan_path,
    }))
  }, [threads.threads, workspaceId])

  const media = useMemo(() => {
    const videos = (videoJobs ?? [])
      .filter((job) => job.status === "completed")
      .map((job) => ({
        key: `v-${job.id}`,
        kind: "video" as const,
        prompt: job.prompt,
        model: job.model,
        at: job.updated_at ?? job.created_at,
        url: connectionId ? videoContentUrl(connectionId, job.job_id) : null,
      }))
    const images = (imageRuns ?? [])
      .filter((run) => run.status === "completed")
      .map((run) => ({
        key: `i-${run.id}`,
        kind: "image" as const,
        prompt: run.prompt,
        model: run.model,
        at: run.updated_at ?? run.created_at,
        url: connectionId ? imageContentUrl(connectionId, run.id) : null,
      }))
    return [...videos, ...images].sort((a, b) =>
      String(b.at).localeCompare(String(a.at))
    )
  }, [videoJobs, imageRuns, connectionId])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/40 px-2 py-1.5">
        {(
            [
              { id: "plans" as Tab, label: "Plans", count: plans.length },
              { id: "media" as Tab, label: "Generated", count: media.length },
            ]
          ).map((entry) => (
          <button
            key={entry.id}
            type="button"
            onClick={() => setTab(entry.id)}
            aria-pressed={tab === entry.id}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs",
              tab === entry.id
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            )}
          >
            {entry.label}
            <span className="tabular-nums opacity-60">{entry.count}</span>
          </button>
        ))}
      </div>

      <div className="scrollbar-hover min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "plans" ? (
          plans.length === 0 ? (
            <Empty
              icon={FileText}
              title="No plan docs yet"
              body="A /plan turn writes one into the workspace, and it shows up here."
            />
          ) : (
            <ul className="flex flex-col gap-1">
              {plans.map(({ thread, name }) => (
                <li key={thread.id}>
                  <div className="flex items-center gap-2 rounded-md border border-border/60 p-2">
                    <FileText className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-foreground">{name}</p>
                      {/* Joined rather than interpolated with fixed separators:
                          `workspaceName` returns "" for a workspace that has since
                          been deleted, which left a dangling "·" at the start of
                          the line. */}
                      <p className="truncate text-xs text-muted-foreground">
                        {[
                          threads.workspaceName(thread.workspace_id),
                          thread.title || "Untitled",
                          timeAgo(thread.updated_at),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        requestOpenFile({
                          workspaceId: thread.workspace_id,
                          path: thread.plan_path,
                          name,
                        })
                      }
                      className="shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      Open file
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        requestOpenThread({
                          workspaceId: thread.workspace_id,
                          threadId: thread.id,
                        })
                      }
                      className="shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      Conversation
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )
        ) : media.length === 0 ? (
          <Empty
            icon={Stack}
            title="Nothing generated yet"
            body={
              connections && connections.length > 0
                ? "Finished clips and images from the Video and Image panes land here."
                : "Connect a LAIOS box to generate video and images."
            }
          />
        ) : (
          <ul className="grid grid-cols-2 gap-2 lg:grid-cols-3">
            {media.map((item) => (
              <li
                key={item.key}
                className="overflow-hidden rounded-lg border border-border/60"
              >
                <div className="flex aspect-video items-center justify-center bg-muted/40">
                  {item.url ? (
                    item.kind === "video" ? (
                      // No autoplay: a grid of clips all playing at once is not a
                      // browse, and a hidden pane keeps running under
                      // `renderer: 'always'`.
                      <video
                        src={item.url}
                        controls
                        preload="metadata"
                        className="h-full w-full object-contain"
                      />
                    ) : (
                      <img
                        src={item.url}
                        alt={item.prompt}
                        loading="lazy"
                        className="h-full w-full object-contain"
                      />
                    )
                  ) : null}
                </div>
                <div className="space-y-0.5 p-2">
                  <p className="line-clamp-2 text-xs text-foreground">
                    {item.prompt || "No prompt"}
                  </p>
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    {item.kind === "video" ? (
                      <FilmSlate className="size-3 shrink-0" />
                    ) : (
                      <ImageSquare className="size-3 shrink-0" />
                    )}
                    <span className="min-w-0 truncate">{item.model}</span>
                    {onOpenPane ? (
                      <button
                        type="button"
                        onClick={() => onOpenPane(item.kind)}
                        className="ml-auto shrink-0 rounded px-1 py-0.5 hover:bg-accent hover:text-foreground"
                      >
                        Open in {item.kind === "video" ? "Video" : "Image"}
                      </button>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function Empty({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof Stack
  title: string
  body: string
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <Icon className="size-7 text-muted-foreground" />
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-xs text-xs text-muted-foreground">{body}</p>
    </div>
  )
}
