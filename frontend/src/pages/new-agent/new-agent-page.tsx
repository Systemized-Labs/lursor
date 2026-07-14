import { useMemo, useRef, useState, type KeyboardEvent } from "react"
import { useNavigate } from "react-router-dom"
import { CaretDown, Monitor, Plus, X } from "@phosphor-icons/react"

import { useAgents } from "@/api/agents"
import { useWorkspaces } from "@/api/workspaces"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { BranchSelector } from "@/pages/new-agent/branch-selector"
import type { PendingAttachment } from "@/agui/types"

/** State handed to the chat surface so it launches straight into a run. */
export interface NewAgentLaunch {
  draft: string
  agentId?: string
  attachments?: PendingAttachment[]
}

/** Read an image File into a staged attachment (data URL for preview + raw
 *  base64 payload for the wire). Mirrors the chat composer's helper. */
async function fileToAttachment(file: File): Promise<PendingAttachment> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
  return {
    id: crypto.randomUUID(),
    name: file.name || "image",
    mimeType: file.type || "image/png",
    dataUrl,
    base64: dataUrl.split(",", 2)[1] ?? "",
  }
}

/**
 * The home surface: a centered composer that kicks off a fresh agent run.
 * Pick a project + agent, optionally attach media, type a prompt, and send —
 * this navigates into the workspace chat and auto-launches the first turn
 * (see WorkspaceChatPage).
 */
export function NewAgentPage() {
  const navigate = useNavigate()
  const workspacesQuery = useWorkspaces()
  const agentsQuery = useAgents()

  const workspaces = useMemo(
    () => workspacesQuery.data ?? [],
    [workspacesQuery.data]
  )
  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data])

  const [draft, setDraft] = useState("")
  const [workspaceId, setWorkspaceId] = useState("")
  const [agentId, setAgentId] = useState("")
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Default the pickers to the first available option once data lands.
  const activeWorkspaceId = workspaceId || workspaces[0]?.id || ""
  const activeAgentId = agentId || agents[0]?.id || ""

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId)
  const activeAgent = agents.find((a) => a.id === activeAgentId)

  const canSend = Boolean((draft.trim() || attachments.length) && activeWorkspaceId)

  async function addFiles(files: FileList | File[]) {
    const images = Array.from(files).filter((f) => f.type.startsWith("image/"))
    if (images.length === 0) return
    const staged = await Promise.all(images.map(fileToAttachment))
    setAttachments((prev) => [...prev, ...staged])
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== id))
  }

  function handleSend() {
    if (!canSend) return
    const launch: NewAgentLaunch = {
      draft: draft.trim(),
      agentId: activeAgentId || undefined,
      attachments: attachments.length ? attachments : undefined,
    }
    navigate(`/workspaces/${activeWorkspaceId}/chat`, { state: launch })
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Centered composer stack */}
      <div className="flex flex-1 items-center justify-center px-4">
        <div className="w-full max-w-2xl">
          {/* Context row: project / branch / machine */}
          <div className="mb-2 flex flex-wrap items-center gap-1 px-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex items-center gap-1 rounded-md px-1.5 py-1 text-sm text-foreground transition-colors hover:bg-muted/60"
                >
                  <span className="max-w-[12rem] truncate">
                    {activeWorkspace?.name ?? "Select project"}
                  </span>
                  <CaretDown className="size-3.5 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {workspaces.length === 0 ? (
                  <DropdownMenuItem disabled>No projects</DropdownMenuItem>
                ) : (
                  workspaces.map((ws) => (
                    <DropdownMenuItem
                      key={ws.id}
                      onSelect={() => setWorkspaceId(ws.id)}
                    >
                      {ws.name}
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>

            {activeWorkspaceId ? (
              <BranchSelector workspaceId={activeWorkspaceId} />
            ) : null}

            <div className="flex items-center gap-1 rounded-md px-1.5 py-1 text-sm text-muted-foreground">
              <Monitor className="size-3.5" />
              <span>This Mac</span>
            </div>
          </div>

          {/* Composer card */}
          <div className="rounded-2xl border border-border/60 bg-muted/40 px-3 py-2.5 shadow-sm transition-[border-color,box-shadow,background-color] duration-200 focus-within:border-ring/30 focus-within:bg-background focus-within:shadow-md focus-within:ring-2 focus-within:ring-ring/15">
            {attachments.length > 0 && (
              <div className="mb-1.5 flex flex-wrap gap-2 px-1">
                {attachments.map((a) => (
                  <div
                    key={a.id}
                    className="group/att relative h-16 w-16 overflow-hidden rounded-lg border border-border/60 bg-background"
                  >
                    <img
                      src={a.dataUrl}
                      alt={a.name}
                      className="h-full w-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => removeAttachment(a.id)}
                      title="Remove attachment"
                      aria-label={`Remove ${a.name}`}
                      className="absolute right-0.5 top-0.5 rounded-full bg-background/80 p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/att:opacity-100"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Plan, Build, / for skills, @ for context"
              rows={2}
              className="min-h-[52px] max-h-60 resize-none border-0 bg-transparent px-1 py-1 text-sm leading-relaxed shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
            />

            <div className="mt-1 flex items-center gap-1.5">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) void addFiles(e.target.files)
                  e.target.value = ""
                }}
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => fileInputRef.current?.click()}
                title="Attach media"
                aria-label="Attach media"
                className="size-8 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
              >
                <Plus className="size-4" />
              </Button>

              {agents.length > 0 ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                    >
                      <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                      <span className="max-w-[16rem] truncate text-foreground">
                        {activeAgent?.name ?? "Select agent"}
                      </span>
                      <CaretDown className="size-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {agents.map((agent) => (
                      <DropdownMenuItem
                        key={agent.id}
                        onSelect={() => setAgentId(agent.id)}
                      >
                        {agent.name}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <span className="px-1.5 text-sm text-muted-foreground">
                  No agents
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Footer hint */}
      <p className="shrink-0 px-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-2 text-center text-sm text-muted-foreground">
        Plugins help you customize your workflows — use{" "}
        <code className="rounded bg-muted px-1 py-0.5 text-xs text-foreground">
          /add-plugin
        </code>{" "}
        to get started
      </p>
    </div>
  )
}
