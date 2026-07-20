import { Robot, NotePencil } from "@phosphor-icons/react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useLocation, useParams, useSearchParams } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { useStore } from "zustand"
import { useStickToBottom } from "use-stick-to-bottom"

import { useAgents } from "@/api/agents"
import {
  threadKeys,
  useActiveRuns,
  useThreads,
  useUpdateThread,
} from "@/api/threads"
import { useDefaultAgents } from "@/api/settings"
import { useWorkspace } from "@/api/workspaces"
import { useChatEngine } from "@/agui/useChatEngine"
import { ChatStoreProvider } from "@/agui/chatStore"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ChatComposer } from "@/components/chat/ChatComposer"
import { ChatTimeline } from "@/components/chat/ChatTimeline"
import { RunningProcessesBar } from "@/components/chat/running-processes-bar"
import { ChatLiveActivity } from "@/components/chat/ChatLiveActivity"
import { ChatTodoList } from "@/components/chat/ChatTodoList"
import { GoalRunPanel } from "@/components/chat/GoalPanel"
import { parseSlashCommand } from "@/components/chat/commands/registry"
import type { CommandAction } from "@/components/chat/commands/types"
import { useWorkspaceChatMentionSources } from "@/components/chat/mentions/sources"
import { requestOpenFile } from "@/lib/open-file"
import type { NewAgentLaunch } from "@/pages/new-agent/new-agent-page"
import type { PendingAttachment } from "@/agui/types"
import type { DefaultAgentsSettings } from "@/api/types"

/** Fallback plan-doc path for legacy threads that predate per-thread plan paths.
 *  Fresh plans carry their own `.agents/plan/PLAN-<slug>.md` path on the run's
 *  goal-status event (and persisted on the thread), opened in the file panel
 *  during plan review. */
const LEGACY_PLAN_DOC = "PLAN.md"

/** Basename of a workspace-relative path, for a file tab's display label. */
function baseName(path: string): string {
  const i = path.lastIndexOf("/")
  return i === -1 ? path : path.slice(i + 1)
}

/**
 * The chat surface for a workspace. Built on a normalized store + engine
 * ({@link useChatEngine}) and use-stick-to-bottom autoscroll, so streamed tokens
 * re-render only the affected message row and the view pins cleanly to the bottom.
 * Owns a single conversation, selected via the `?c=<threadId>` URL param.
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
  const [gameOpen, setGameOpen] = useState(false)
  const mentionSources = useWorkspaceChatMentionSources(workspaceId)
  const { data: defaultAgents } = useDefaultAgents()

  const chat = useChatEngine({
    workspaceId,
    agentId: selectedAgentId || undefined,
    activeRuns,
    reconnect: true,
    onThreadCreated: (thread) => {
      qc.invalidateQueries({ queryKey: threadKeys.byWorkspace(thread.workspace_id) })
      setSearchParams({ c: thread.id }, { replace: true })
    },
  })
  const { store, loadConversation, startNewConversation } = chat

  // Reactive slices of chat state. Each is low-frequency (start/end/settle), so
  // subscribing here never re-renders the page per streamed token.
  const selectedThreadId = useStore(store, (s) => s.selectedThreadId)
  const isStreaming = useStore(store, (s) => s.isStreaming)
  const todos = useStore(store, (s) => s.todos)
  const goalStatus = useStore(store, (s) => s.goalStatus)
  const error = useStore(store, (s) => s.error)
  const queue = useStore(store, (s) => s.queue)
  const queuePaused = useStore(store, (s) => s.queuePaused)

  // Scroll instance owned here so send/interject can re-pin to the bottom.
  const stick = useStickToBottom({ resize: "smooth", initial: "instant" })

  // The URL is the source of truth for which conversation is open.
  const prevCParam = useRef(cParam)
  useEffect(() => {
    const cParamCleared = prevCParam.current !== cParam && !cParam
    prevCParam.current = cParam
    if (cParam) {
      if (cParam !== selectedThreadId) void loadConversation(cParam)
    } else if (cParamCleared && selectedThreadId !== null) {
      // Only reset when the URL param was actually cleared (New conversation).
      startNewConversation()
    }
  }, [cParam, selectedThreadId, loadConversation, startNewConversation])

  // A prompt arriving from the New Agent home surface: pre-select its agent.
  useEffect(() => {
    const launch = location.state as NewAgentLaunch | null
    if (launch?.agentId) setSelectedAgentId(launch.agentId)
  }, [location.state])

  // Keep the agent picker in sync with the open thread (or defaults for a new one).
  useEffect(() => {
    if (selectedThreadId) {
      const t = threads.find((x) => x.id === selectedThreadId)
      if (t) setSelectedAgentId(t.agent_id)
    } else {
      const chatDefault = defaultAgents?.chat
      const seedable =
        chatDefault && agents.some((a) => a.id === chatDefault)
          ? chatDefault
          : agents[0]?.id
      setSelectedAgentId((prev) => prev || seedable || "")
    }
  }, [selectedThreadId, threads, agents, defaultAgents])

  // Auto-launch the first turn when we arrive from the New Agent home surface.
  const launchedRef = useRef(false)
  useEffect(() => {
    if (launchedRef.current) return
    const launch = location.state as NewAgentLaunch | null
    if (!launch || (!launch.draft && !launch.attachments?.length)) return
    if (cParam || agents.length === 0 || !selectedAgentId) return
    launchedRef.current = true
    const text = launch.draft
    const atts = launch.attachments ?? []
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

  function defaultAgentFor(key: keyof DefaultAgentsSettings): string | undefined {
    const id = defaultAgents?.[key]
    return id && agents.some((a) => a.id === id) ? id : undefined
  }

  function handleNewConversation() {
    const chatDefault = defaultAgentFor("chat")
    if (chatDefault) setSelectedAgentId(chatDefault)
    setSearchParams({})
  }

  function runCommandAction(action: CommandAction) {
    if (action === "new-conversation") handleNewConversation()
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
    // Sending re-pins to the bottom so the user sees their turn and its reply.
    void stick.scrollToBottom()

    // Slash-command dispatch — generic over the command's `kind`.
    const parsed = parseSlashCommand(text)
    if (parsed) {
      const { command, args } = parsed
      if (command.argumentHint && !args) {
        toast.error(`Add text, e.g. "/${command.name} ${command.argumentHint}"`)
        setDraft(text)
        return
      }
      if (command.agentKey) {
        const target = defaultAgentFor(command.agentKey)
        if (target && target !== selectedAgentId) void handleAgentChange(target)
      }
      switch (command.kind) {
        case "turn-intent":
          await chat.send(args, atts, command.turnIntent ?? "chat")
          return
        case "action":
          if (command.action) runCommandAction(command.action)
          return
      }
    }
    // A plain message always executes as a normal chat turn. To refine a parked
    // plan instead, the user sends `/plan …` again.
    await chat.send(text, atts, "chat")
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  // Steer a goal that's already executing: buffered into the loop's next turn.
  async function handleInterject() {
    const text = draft.trim()
    if (!text) return
    setDraft("")
    void stick.scrollToBottom()
    await chat.interject(text)
  }

  function handleInterjectKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void handleInterject()
    }
  }

  const currentThread = threads.find((t) => t.id === selectedThreadId)
  const noAgents = agents.length === 0

  const runView = goalStatus
  const goalExecuting = runView?.status === "running"

  // Open the thread's plan doc in the file panel when a `/plan` turn parks it in
  // review. Two sources of "parked": the live goal-status event (fresh, carries the
  // exact per-thread path) and the persisted thread (survives a reload, when the
  // live event is gone — a parked plan is `status === "awaiting_approval"` with a
  // `plan_path`). Edge-triggered per thread so it opens once each time a thread
  // enters review (and reopens on the next `/plan` refinement), and opens when you
  // switch to / reload an already-parked plan thread. Path prefers the live event,
  // then the persisted field, then the legacy top-level PLAN.md.
  const prevParkedRef = useRef<{ id?: string; parked: boolean }>({ parked: false })
  useEffect(() => {
    const parked =
      runView?.status === "awaiting_approval" ||
      (currentThread?.status === "awaiting_approval" && !!currentThread?.plan_path)
    const prev = prevParkedRef.current
    // Only treat it as a fresh edge within the same thread; switching threads
    // starts each one's edge at "not parked" so its plan opens on arrival.
    const wasParked = prev.id === selectedThreadId ? prev.parked : false
    prevParkedRef.current = { id: selectedThreadId ?? undefined, parked }
    if (parked && !wasParked && workspaceId) {
      const path = runView?.planPath || currentThread?.plan_path || LEGACY_PLAN_DOC
      requestOpenFile({ workspaceId, path, name: baseName(path) })
    }
  }, [
    selectedThreadId,
    runView?.status,
    runView?.planPath,
    currentThread?.status,
    currentThread?.plan_path,
    workspaceId,
  ])

  if (workspaceQuery.isLoading) {
    return <p className="p-6 text-sm text-muted-foreground">Loading workspace…</p>
  }
  if (workspaceQuery.isError || !workspace) {
    return <p className="p-6 text-sm text-destructive">Workspace not found</p>
  }

  return (
    <ChatStoreProvider value={store}>
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
        {/* Header */}
        <div className="flex h-9 shrink-0 items-center gap-3 bg-background/70 px-3 backdrop-blur-sm">
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
            {isStreaming && (
              <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
                </span>
                Thinking…
              </span>
            )}
          </div>

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

        <ChatTimeline
          instance={stick}
          resetKey={selectedThreadId ?? undefined}
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

        {/* Tasks live in the run deck while a goal executes; otherwise their own card. */}
        {todos.length > 0 && !goalExecuting && (
          <div className="mx-auto w-full max-w-3xl px-4 pb-1 sm:px-6">
            <ChatTodoList todos={todos} />
          </div>
        )}

        {error ? (
          <p className="px-4 pb-1 text-sm text-destructive">{error}</p>
        ) : null}

        {/* Live agent activity for the running turn: the latest tool call in a
            single-slot ticker above the "working" dots, cleared once it settles. */}
        <ChatLiveActivity />

        {/* Running background processes (dev servers, watchers) — click one to
            open its read-only output on the right. */}
        <RunningProcessesBar workspaceId={workspaceId} />

        {goalExecuting ? (
          <GoalRunPanel
            objective={runView?.condition ?? ""}
            iteration={runView?.iteration ?? 0}
            maxIterations={runView?.maxIterations ?? 0}
            reason={runView?.reason ?? ""}
            todos={todos}
            gameOpen={gameOpen}
            onToggleGame={() => setGameOpen((o) => !o)}
            onStop={chat.stop}
          >
            <ChatComposer
              input={draft}
              onInputChange={setDraft}
              onKeyDown={handleInterjectKeyDown}
              onSend={() => void handleInterject()}
              onStop={chat.stop}
              isSending={false}
              disabled={noAgents}
              placeholder="Send a message to steer the goal…"
              mentionSources={mentionSources}
              embedded
            />
          </GoalRunPanel>
        ) : (
          <ChatComposer
            input={draft}
            onInputChange={setDraft}
            onKeyDown={handleKeyDown}
            onSend={() => void handleSend()}
            onStop={chat.stop}
            isSending={isStreaming}
            disabled={noAgents}
            placeholder="Type a message, or / for commands…"
            attachments={attachments}
            onAttachmentsChange={setAttachments}
            mentionSources={mentionSources}
            queuedMessages={queue}
            queuePaused={queuePaused}
            onRemoveQueued={chat.removeQueued}
            onEditQueued={chat.editQueued}
            onResumeQueue={chat.resumeQueue}
          />
        )}
      </div>
    </ChatStoreProvider>
  )
}
