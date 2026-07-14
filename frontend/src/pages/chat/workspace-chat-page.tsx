import { Robot, NotePencil } from "@phosphor-icons/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useLocation, useParams, useSearchParams } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { useAgents } from "@/api/agents"
import {
  threadKeys,
  threadsApi,
  useActiveRuns,
  useThreads,
  useUpdateThread,
} from "@/api/threads"
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
import { ChatModeSelect } from "@/components/chat/ChatModeSelect"
import { ChatTodoList } from "@/components/chat/ChatTodoList"
import { GoalBanner, GoalSetup, type GoalDraft } from "@/components/chat/GoalPanel"
import { useWorkspaceChatMentionSources } from "@/components/chat/mentions/sources"
import { requestOpenFile } from "@/lib/open-file"
import type { NewAgentLaunch } from "@/pages/new-agent/new-agent-page"
import type { PendingAttachment } from "@/agui/types"
import type { ChatMode, GoalStatus, TurnMode } from "@/api/types"

/** Workspace-relative path the goal agent writes its plan to (see backend
 *  `goal_loop.PLAN_DOC`); opened in the file panel during plan review. */
const GOAL_PLAN_DOC = "GOAL_PLAN.md"

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
  // Composer mode dropdown. `ask`/`edit` are per-turn modifiers on a chat
  // thread; `plan` starts (or reflects) a goal thread. Defaults to `edit` and
  // resets on New conversation. An open goal thread forces `plan`.
  const [chatMode, setChatMode] = useState<ChatMode>("edit")
  const [approving, setApproving] = useState(false)
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

  // Keep the agent picker + mode toggle in sync with the open thread (or the
  // defaults for a new one).
  useEffect(() => {
    if (selectedThreadId) {
      const t = threads.find((x) => x.id === selectedThreadId)
      if (t) {
        setSelectedAgentId(t.agent_id)
        // A goal thread pins the dropdown to Plan. A chat thread keeps the
        // user's current Ask/Edit choice (it's per-turn, not persisted) — don't
        // clobber it when the thread row loads after the first send; only coerce
        // away from Plan, which isn't valid on a chat thread.
        if (t.mode === "goal") setChatMode("plan")
        else setChatMode((prev) => (prev === "plan" ? "edit" : prev))
      }
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
    setChatMode("edit")
    setSearchParams({})
  }

  async function handleStartGoal(goalDraft: GoalDraft) {
    if (!workspaceId || !selectedAgentId) {
      toast.error("Pick an agent before starting a goal.")
      return
    }
    // Entering Plan mid-conversation: promote the open chat thread into a goal
    // thread (keeping its history), then send the objective — the backend sees
    // mode=goal and runs the planning driver. On a fresh conversation there is
    // no thread yet, so use startGoal's lazy-create path instead.
    if (selectedThreadId) {
      try {
        await updateThread.mutateAsync({
          id: selectedThreadId,
          input: {
            mode: "goal",
            goal: goalDraft.goal,
            success_criteria: goalDraft.successCriteria,
            max_iterations: goalDraft.maxIterations,
            require_plan_approval: goalDraft.requirePlanApproval,
          },
        })
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to start plan")
        return
      }
      await chat.send(goalDraft.goal)
      return
    }
    // startGoal lazily creates the goal thread and sends the objective in one
    // path (see useChat), so the plan and messages aren't wiped by a concurrent
    // conversation load. onThreadCreated syncs the URL to the new thread.
    await chat.startGoal(goalDraft.goal, {
      goal: goalDraft.goal,
      successCriteria: goalDraft.successCriteria,
      maxIterations: goalDraft.maxIterations,
      requirePlanApproval: goalDraft.requirePlanApproval,
    })
  }

  async function handleApproveGoal() {
    if (!selectedThreadId) return
    setApproving(true)
    try {
      // Approval starts a fresh execution run server-side; follow its stream.
      await threadsApi.approveGoal(selectedThreadId)
      chat.followRun()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to approve plan")
    } finally {
      setApproving(false)
    }
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
    isUserScrolledUpRef.current = false
    setIsAtBottom(true)
    setHasNewBelow(false)
    // Composer sends are ask/edit turns. `plan` on a fresh conversation goes
    // through GoalSetup instead; once a goal thread exists these turns refine
    // the plan and the backend ignores the turn mode.
    const turnMode: TurnMode = chatMode === "ask" ? "ask" : "edit"
    await chat.send(text, atts, turnMode)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  // --- auto-scroll plumbing --------------------------------------------------
  // The timeline follows new content by default. Once the user scrolls away
  // from the bottom they "detach": auto-scroll pauses and a floating button
  // offers to re-pin ("reattach"). Content streaming in while detached lights
  // the button up as "New messages".
  const containerRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const isUserScrolledUpRef = useRef(false)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const [hasNewBelow, setHasNewBelow] = useState(false)

  // Track whether the user has scrolled away from the bottom.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      const scrolledUp = distFromBottom > 150
      isUserScrolledUpRef.current = scrolledUp
      setIsAtBottom(!scrolledUp)
      if (!scrolledUp) setHasNewBelow(false)
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
    // Re-bind once messages first render (the container may be empty initially).
  }, [chat.messages.length > 0])

  // Auto-scroll to bottom unless the user has detached.
  const prevMessageCountRef = useRef(0)
  useEffect(() => {
    const prevCount = prevMessageCountRef.current
    prevMessageCountRef.current = chat.messages.length
    if (prevCount === 0 && chat.messages.length > 0) {
      // First render of a conversation: jump straight to the latest turn.
      endRef.current?.scrollIntoView({ behavior: "instant" })
      isUserScrolledUpRef.current = false
      setIsAtBottom(true)
      setHasNewBelow(false)
      return
    }
    if (!isUserScrolledUpRef.current) {
      endRef.current?.scrollIntoView({ behavior: "smooth" })
    } else {
      // Content arrived while the user is reading older messages — flag it on
      // the "jump to latest" button.
      setHasNewBelow(true)
    }
  }, [chat.messages])

  // Re-pin to the bottom and resume auto-scroll (the "reattach" action).
  const scrollToBottom = useCallback(() => {
    isUserScrolledUpRef.current = false
    setIsAtBottom(true)
    setHasNewBelow(false)
    endRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [])

  const currentThread = threads.find((t) => t.id === selectedThreadId)
  const noAgents = agents.length === 0

  // A goal ("plan") thread: mode persisted as goal, or a live goal stream.
  // Picking Plan in the dropdown does NOT itself make the thread a goal thread —
  // it first shows the setup form; the thread is promoted only once planning
  // starts (fresh create or mid-conversation conversion).
  const isGoalThread = currentThread?.mode === "goal" || chat.goalStatus !== null
  // Plan selected but not yet running a goal → collect objective/criteria. Works
  // on a fresh conversation and mid-chat (Plan can be entered at any time).
  const showGoalSetup = chatMode === "plan" && !isGoalThread
  // Prefer the live stream status; fall back to the thread's persisted goal state
  // (e.g. reopening a finished/paused goal that isn't currently streaming).
  const goalView: {
    status: GoalStatus
    condition: string
    iteration: number
    maxIterations: number
    reason: string
  } | null = chat.goalStatus
    ? { ...chat.goalStatus }
    : currentThread?.mode === "goal"
      ? {
          status: currentThread.goal_status,
          condition: currentThread.success_criteria || currentThread.goal,
          iteration: currentThread.iteration,
          maxIterations: currentThread.max_iterations,
          reason: currentThread.last_reason,
        }
      : null
  // A goal thread is pinned to Plan (its lifecycle can't switch back). Otherwise
  // all three modes are selectable — Ask/Edit are per-turn, and Plan can be
  // entered at any time (promotes the current chat thread into a plan).
  const modeLocked = isGoalThread
  const availableModes: ChatMode[] = isGoalThread ? ["plan"] : ["ask", "edit", "plan"]
  // The agent is actively executing (autonomous loop) — offer Stop, not chat.
  const goalExecuting = goalView?.status === "running"

  // When a goal thread enters plan review, open its plan doc in the file panel
  // so the user can read the plan while iterating. Once per thread.
  const planOpenedForRef = useRef<string | null>(null)
  useEffect(() => {
    if (!workspaceId || !selectedThreadId) return
    if (
      goalView?.status === "awaiting_approval" &&
      planOpenedForRef.current !== selectedThreadId
    ) {
      planOpenedForRef.current = selectedThreadId
      requestOpenFile({
        workspaceId,
        path: GOAL_PLAN_DOC,
        name: GOAL_PLAN_DOC,
      })
    }
  }, [goalView?.status, workspaceId, selectedThreadId])

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
        hasNewMessages={hasNewBelow}
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

      {goalView && (
        <div className="px-4 pb-1 sm:px-6">
          <GoalBanner
            status={goalView.status}
            condition={goalView.condition}
            iteration={goalView.iteration}
            maxIterations={goalView.maxIterations}
            reason={goalView.reason}
            approving={approving}
            onApprove={() => void handleApproveGoal()}
          />
        </div>
      )}

      {chat.todos.length > 0 && (
        <div className="px-4 pb-1 sm:px-6">
          <ChatTodoList todos={chat.todos} />
        </div>
      )}

      {chat.error ? (
        <p className="px-4 pb-1 text-sm text-destructive">{chat.error}</p>
      ) : null}

      {showGoalSetup ? (
        // Plan selected: collect the objective. The mode dropdown sits above the
        // form so the user can still switch back to Ask/Edit.
        <div className="px-4 pb-4 pt-1 sm:px-6">
          {/* Align the mode dropdown with the (centered, max-w-3xl) goal card. */}
          <div className="mx-auto mb-2 w-full max-w-3xl">
            <ChatModeSelect
              mode={chatMode}
              onModeChange={setChatMode}
              availableModes={availableModes}
              locked={modeLocked}
              disabled={noAgents}
            />
          </div>
          <GoalSetup disabled={noAgents} onStart={(d) => void handleStartGoal(d)} />
        </div>
      ) : isGoalThread && goalExecuting ? (
        // Autonomous execution is running: offer Stop, not the composer.
        <div className="flex items-center justify-center px-4 pb-4 pt-1 sm:px-6">
          <Button variant="outline" size="sm" onClick={chat.stop}>
            Stop goal
          </Button>
        </div>
      ) : (
        // Plain chat, or goal planning/review — the composer stays available so
        // the user can iterate on the plan before approving. The mode dropdown
        // lives in the composer's own toolbar.
        <ChatComposer
          input={draft}
          onInputChange={setDraft}
          onKeyDown={handleKeyDown}
          onSend={() => void handleSend()}
          onStop={chat.stop}
          isSending={chat.isStreaming}
          disabled={noAgents}
          placeholder={
            isGoalThread ? "Refine the plan, then approve to run…" : undefined
          }
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          mentionSources={mentionSources}
          queuedMessages={chat.queue}
          queuePaused={chat.queuePaused}
          onRemoveQueued={chat.removeQueued}
          onEditQueued={chat.editQueued}
          onResumeQueue={chat.resumeQueue}
          mode={chatMode}
          onModeChange={setChatMode}
          availableModes={availableModes}
          modeLocked={modeLocked}
        />
      )}
    </div>
  )
}
