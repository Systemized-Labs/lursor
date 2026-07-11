import { Robot, NotePencil } from "@phosphor-icons/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useLocation, useParams, useSearchParams } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { useAgents } from "@/api/agents"
import { threadKeys, useActiveRuns, useThreads, useUpdateThread } from "@/api/threads"
import { useWorkspace } from "@/api/workspaces"
import { useChat } from "@/agui/useChat"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ChatComposer } from "@/components/chat/ChatComposer"
import { ChatMessageList } from "@/components/chat/ChatMessageList"
import { useWorkspaceChatMentionSources } from "@/components/chat/mentions/sources"
import type { NewAgentLaunch } from "@/pages/new-agent/new-agent-page"
import type { PendingAttachment } from "@/agui/types"

/**
 * The chat surface for a workspace. The conversation list lives in the left app
 * nav now; this page owns a single conversation, selected via the `?c=<threadId>`
 * URL param (absent = a new conversation). The header carries the agent switcher,
 * which swaps the current thread's agent in place.
 */
export function WorkspaceChatPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  const cParam = searchParams.get("c")
  const qc = useQueryClient()

  const workspaceQuery = useWorkspace(workspaceId)
  const agentsQuery = useAgents()
  const threadsQuery = useThreads(workspaceId)
  const activeRunsQuery = useActiveRuns()
  const updateThread = useUpdateThread()

  const workspace = workspaceQuery.data
  const threads = useMemo(() => threadsQuery.data ?? [], [threadsQuery.data])
  const activeRuns = useMemo(
    () => new Set(activeRunsQuery.data ?? []),
    [activeRunsQuery.data]
  )
  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data])

  const [selectedAgentId, setSelectedAgentId] = useState("")
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState("")
  const [draft, setDraft] = useState("")
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const mentionSources = useWorkspaceChatMentionSources(workspaceId)

  const chat = useChat({
    workspaceId,
    agentId: selectedAgentId || undefined,
    activeRuns,
    reconnect: true,
    onThreadCreated: (thread) => {
      qc.invalidateQueries({ queryKey: threadKeys.byWorkspace(thread.workspace_id) })
      setSearchParams({ c: thread.id }, { replace: true })
    },
  })
  const { loadConversation, startNewConversation, selectedThreadId } = chat

  // The URL is the source of truth for which conversation is open.
  const prevCParam = useRef(cParam)
  useEffect(() => {
    const cParamCleared = prevCParam.current !== cParam && !cParam
    prevCParam.current = cParam
    if (cParam) {
      if (cParam !== selectedThreadId) void loadConversation(cParam)
    } else if (cParamCleared && selectedThreadId !== null) {
      // Only reset when the URL param was actually cleared (user hit "New
      // conversation"). During a lazy first-send the chat sets selectedThreadId
      // before the URL catches up; resetting here would abort the fresh run.
      startNewConversation()
    }
  }, [cParam, selectedThreadId, loadConversation, startNewConversation])

  // A prompt arriving from the New Agent home surface: pre-select its agent so
  // the auto-launch below uses it rather than the default first agent.
  useEffect(() => {
    const launch = location.state as NewAgentLaunch | null
    if (launch?.agentId) setSelectedAgentId(launch.agentId)
  }, [location.state])

  // Keep the agent picker in sync with the open thread (or the default for a new one).
  useEffect(() => {
    if (selectedThreadId) {
      const t = threads.find((x) => x.id === selectedThreadId)
      if (t) setSelectedAgentId(t.agent_id)
    } else {
      setSelectedAgentId((prev) => prev || agents[0]?.id || "")
    }
  }, [selectedThreadId, threads, agents])

  // Auto-launch the first turn when we arrive from the New Agent home surface.
  // Guarded so a refresh/back-nav (which drops the router state) can't resend.
  const launchedRef = useRef(false)
  useEffect(() => {
    if (launchedRef.current) return
    const launch = location.state as NewAgentLaunch | null
    if (!launch || (!launch.draft && !launch.attachments?.length)) return
    // Only launch into a fresh conversation with an agent ready to run.
    if (cParam || agents.length === 0 || !selectedAgentId) return
    launchedRef.current = true
    const text = launch.draft
    const atts = launch.attachments ?? []
    // Drop the router state so the prompt isn't replayed on remount.
    window.history.replaceState({}, "")
    void chat.send(text, atts)
  }, [location.state, cParam, agents, selectedAgentId, chat])

  async function handleAgentChange(agentId: string) {
    setSelectedAgentId(agentId)
    if (selectedThreadId) {
      try {
        await updateThread.mutateAsync({
          id: selectedThreadId,
          input: { agent_id: agentId },
        })
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to switch agent")
      }
    }
  }

  function handleNewConversation() {
    setSearchParams({})
  }

  function startEditingTitle() {
    if (!currentThread) return
    setTitleDraft(currentThread.title)
    setIsEditingTitle(true)
  }

  async function commitTitle() {
    setIsEditingTitle(false)
    const next = titleDraft.trim()
    if (!currentThread || !next || next === currentThread.title) return
    try {
      await updateThread.mutateAsync({
        id: currentThread.id,
        input: { title: next },
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to rename conversation")
    }
  }

  function handleTitleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault()
      void commitTitle()
    } else if (e.key === "Escape") {
      e.preventDefault()
      setIsEditingTitle(false)
    }
  }

  async function handleSend() {
    const text = draft
    const atts = attachments
    setDraft("")
    setAttachments([])
    await chat.send(text, atts)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  // --- auto-scroll plumbing --------------------------------------------------
  const containerRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const isUserScrolledUpRef = useRef(false)
  const [isAtBottom, setIsAtBottom] = useState(true)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      const scrolledUp = distFromBottom > 150
      isUserScrolledUpRef.current = scrolledUp
      setIsAtBottom(!scrolledUp)
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
  }, [])

  useEffect(() => {
    if (!isUserScrolledUpRef.current) {
      endRef.current?.scrollIntoView({ behavior: "smooth" })
    }
  }, [chat.messages])

  const scrollToBottom = useCallback(() => {
    isUserScrolledUpRef.current = false
    setIsAtBottom(true)
    endRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [])

  const currentThread = threads.find((t) => t.id === selectedThreadId)
  const noAgents = agents.length === 0

  if (workspaceQuery.isLoading) {
    return <p className="p-6 text-sm text-muted-foreground">Loading workspace…</p>
  }
  if (workspaceQuery.isError || !workspace) {
    return <p className="p-6 text-sm text-destructive">Workspace not found</p>
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {/* Header */}
      <div className="flex h-9 shrink-0 items-center gap-3 bg-background/70 px-3 backdrop-blur-sm">
        {/* Conversation title + live status */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {isEditingTitle ? (
            <input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => void commitTitle()}
              onKeyDown={handleTitleKeyDown}
              aria-label="Conversation title"
              className="min-w-0 flex-1 rounded-md bg-accent px-1.5 py-0.5 text-sm font-medium text-foreground outline-none ring-1 ring-primary/40 focus:ring-primary"
            />
          ) : currentThread ? (
            <button
              type="button"
              onClick={startEditingTitle}
              title="Rename conversation"
              className="min-w-0 truncate rounded-md px-1.5 py-0.5 text-left text-sm font-medium text-foreground hover:bg-accent"
            >
              {currentThread.title}
            </button>
          ) : (
            <span className="truncate px-1.5 text-sm font-medium text-foreground">
              New conversation
            </span>
          )}
          {chat.isStreaming && (
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
              </span>
              Thinking…
            </span>
          )}
        </div>

        {/* Controls */}
        <div className="flex shrink-0 items-center gap-0.5">
          {noAgents ? (
            <span className="text-xs text-muted-foreground">No agents</span>
          ) : (
            <Select
              value={selectedAgentId}
              onValueChange={(v) => void handleAgentChange(v)}
            >
              <SelectTrigger
                aria-label="Agent"
                className="h-7 gap-1.5 rounded-md border-0 bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground focus:ring-0 data-[state=open]:bg-accent data-[state=open]:text-foreground"
              >
                <SelectValue placeholder="Select agent" />
              </SelectTrigger>
              <SelectContent align="end">
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={handleNewConversation}
            aria-label="New conversation"
            title="New conversation"
          >
            <NotePencil className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <ChatMessageList
        messages={chat.messages}
        endRef={endRef}
        containerRef={containerRef}
        className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5 sm:px-6"
        renderIcons
        showScrollToBottom={!isAtBottom}
        onScrollToBottom={scrollToBottom}
        empty={
          <div className="flex h-full items-center justify-center">
            <div className="space-y-3 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/15">
                <Robot className="h-7 w-7 text-primary" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-semibold text-foreground">
                  {noAgents ? "No agents yet" : "Start the conversation"}
                </p>
                <p className="mx-auto max-w-[16rem] text-xs text-muted-foreground">
                  {noAgents
                    ? "Create an agent in Customization to start chatting."
                    : "Pick an agent above and send the first message."}
                </p>
              </div>
            </div>
          </div>
        }
      />

      {chat.error ? (
        <p className="px-4 pb-1 text-sm text-destructive">{chat.error}</p>
      ) : null}

      <ChatComposer
        input={draft}
        onInputChange={setDraft}
        onKeyDown={handleKeyDown}
        onSend={() => void handleSend()}
        onStop={chat.stop}
        isSending={chat.isStreaming}
        disabled={noAgents}
        attachments={attachments}
        onAttachmentsChange={setAttachments}
        mentionSources={mentionSources}
      />
    </div>
  )
}
