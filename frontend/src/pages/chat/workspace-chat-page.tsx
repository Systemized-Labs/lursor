import { Bot, MessageSquarePlus } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useParams, useSearchParams } from "react-router-dom"
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

/**
 * The chat surface for a workspace. The conversation list lives in the left app
 * nav now; this page owns a single conversation, selected via the `?c=<threadId>`
 * URL param (absent = a new conversation). The header carries the agent switcher,
 * which swaps the current thread's agent in place.
 */
export function WorkspaceChatPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
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
  const [draft, setDraft] = useState("")

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

  // Keep the agent picker in sync with the open thread (or the default for a new one).
  useEffect(() => {
    if (selectedThreadId) {
      const t = threads.find((x) => x.id === selectedThreadId)
      if (t) setSelectedAgentId(t.agent_id)
    } else {
      setSelectedAgentId((prev) => prev || agents[0]?.id || "")
    }
  }, [selectedThreadId, threads, agents])

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

  async function handleSend() {
    const text = draft
    setDraft("")
    await chat.send(text)
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
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-card">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border/60 bg-card/60 px-4 py-2.5 backdrop-blur-sm">
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-sm font-semibold text-foreground">
            {currentThread?.title ?? "New conversation"}
          </span>
          <span className="text-[11px] text-muted-foreground">
            {chat.isStreaming ? "Thinking…" : workspace.name}
          </span>
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={handleNewConversation}
          aria-label="New conversation"
          title="New conversation"
        >
          <MessageSquarePlus className="h-4 w-4" />
        </Button>

        {noAgents ? (
          <span className="text-xs text-muted-foreground">No agents</span>
        ) : (
          <Select
            value={selectedAgentId}
            onValueChange={(v) => void handleAgentChange(v)}
          >
            <SelectTrigger className="h-8 w-44" aria-label="Agent">
              <SelectValue placeholder="Select agent" />
            </SelectTrigger>
            <SelectContent>
              {agents.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
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
                <Bot className="h-7 w-7 text-primary" />
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
      />
    </div>
  )
}
