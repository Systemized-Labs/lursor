import { Robot, NotePencil } from "@phosphor-icons/react"
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useLocation, useParams, useSearchParams } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { useAgents } from "@/api/agents"
import {
  threadKeys,
  useActiveRuns,
  useThreads,
  useUpdateThread,
} from "@/api/threads"
import { useDefaultAgents } from "@/api/settings"
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
import { ChatTodoList } from "@/components/chat/ChatTodoList"
import { GoalRunPanel } from "@/components/chat/GoalPanel"
import { parseSlashCommand } from "@/components/chat/commands/registry"
import type { CommandAction } from "@/components/chat/commands/types"
import { useWorkspaceChatMentionSources } from "@/components/chat/mentions/sources"
import { requestOpenFile } from "@/lib/open-file"
import type { NewAgentLaunch } from "@/pages/new-agent/new-agent-page"
import type { PendingAttachment } from "@/agui/types"
import type { DefaultAgentsSettings, RunStatus, ThreadMode } from "@/api/types"

/** Default iteration cap for a `/goal` run (backend default). */
const GOAL_MAX_ITERATIONS = 25

/** Workspace-relative path the plan agent writes its plan to (see backend
 *  `goal_loop.PLAN_DOC`); opened in the file panel during plan review. */
const PLAN_DOC = "PLAN.md"

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
  const [gameOpen, setGameOpen] = useState(false)
  const mentionSources = useWorkspaceChatMentionSources(workspaceId)
  const { data: defaultAgents } = useDefaultAgents()

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

  // Keep the agent picker in sync with the open thread (or the defaults for a
  // new one).
  useEffect(() => {
    if (selectedThreadId) {
      const t = threads.find((x) => x.id === selectedThreadId)
      if (t) setSelectedAgentId(t.agent_id)
    } else {
      // A fresh conversation seeds the agent from the `chat` command default
      // when set, else the first agent. `prev ||` avoids clobbering a selection
      // the user already made.
      const chatDefault = defaultAgents?.chat
      const seedable =
        chatDefault && agents.some((a) => a.id === chatDefault)
          ? chatDefault
          : agents[0]?.id
      setSelectedAgentId((prev) => prev || seedable || "")
    }
  }, [selectedThreadId, threads, agents, defaultAgents])

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

  // The default agent configured for a command, but only if it still exists.
  function defaultAgentFor(key: keyof DefaultAgentsSettings): string | undefined {
    const id = defaultAgents?.[key]
    return id && agents.some((a) => a.id === id) ? id : undefined
  }

  function handleNewConversation() {
    const chatDefault = defaultAgentFor("chat")
    if (chatDefault) setSelectedAgentId(chatDefault)
    setSearchParams({})
  }

  // Enter a sticky mode (plan/goal). On a fresh conversation, lazily creates the
  // thread with the mode config (startMode avoids the load/clobber race). On an
  // open chat thread, promotes it in place (keeping history), then sends the
  // first turn. The condition/objective is the text after the command.
  async function enterMode(mode: ThreadMode, text: string) {
    if (!workspaceId || !selectedAgentId) {
      toast.error("Pick an agent before starting a plan or goal.")
      return
    }
    if (selectedThreadId) {
      try {
        await updateThread.mutateAsync({
          id: selectedThreadId,
          input: {
            mode,
            goal: text,
            success_criteria: "",
            max_iterations: GOAL_MAX_ITERATIONS,
          },
        })
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to start")
        return
      }
      await chat.send(text, [], "chat", mode)
      return
    }
    await chat.startMode(text, {
      mode,
      goal: text,
      successCriteria: "",
      maxIterations: GOAL_MAX_ITERATIONS,
    })
  }

  // Return a plan/goal thread to plain chat (exit the sticky mode).
  async function handleExitMode() {
    if (!selectedThreadId) return
    try {
      await updateThread.mutateAsync({
        id: selectedThreadId,
        input: { mode: "chat" },
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to exit mode")
    }
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
    stickToBottomRef.current = true
    setIsAtBottom(true)
    setHasNewBelow(false)

    // Slash-command dispatch — generic over the command's `kind`. A plain
    // message (no command) sends a normal chat turn. Adding a command is a
    // registry entry; nothing here changes for a new turn-intent/action command.
    const parsed = parseSlashCommand(text)
    if (parsed) {
      const { command, args } = parsed
      // Commands that take an argument need one (e.g. /goal, /plan, /ask).
      if (command.argumentHint && !args) {
        toast.error(`Add text, e.g. "/${command.name} ${command.argumentHint}"`)
        setDraft(text) // keep what they typed so they can finish it
        return
      }
      // Switch to the command's default agent when one is configured.
      if (command.agentKey) {
        const target = defaultAgentFor(command.agentKey)
        if (target && target !== selectedAgentId) void handleAgentChange(target)
      }
      switch (command.kind) {
        case "turn-intent":
          await chat.send(args, atts, command.turnIntent ?? "chat")
          return
        case "thread-mode":
          if (command.enterMode) await enterMode(command.enterMode, args)
          return
        case "action":
          if (command.action) runCommandAction(command.action)
          return
      }
    }
    // A plain message in plan mode is a plan-refinement turn — badge it "plan".
    await chat.send(text, atts, "chat", activeMode === "plan" ? "plan" : "chat")
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  // Steer a goal that's already executing: the message is buffered into the
  // loop's next turn rather than starting a new run.
  async function handleInterject() {
    const text = draft.trim()
    if (!text) return
    setDraft("")
    stickToBottomRef.current = true
    setIsAtBottom(true)
    setHasNewBelow(false)
    await chat.interject(text)
  }

  function handleInterjectKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void handleInterject()
    }
  }

  // --- auto-scroll plumbing --------------------------------------------------
  // The timeline follows new content by default. Once the user scrolls away
  // from the bottom they "detach": auto-scroll pauses and a floating button
  // offers to re-pin ("reattach"). Content streaming in while detached lights
  // the button up as "New messages".
  const containerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  // Whether the timeline should keep following new content. Flipped off only
  // when the user scrolls away from the bottom, and back on when they return.
  const stickToBottomRef = useRef(true)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const [hasNewBelow, setHasNewBelow] = useState(false)

  // Distance from the bottom (px) still treated as "pinned". A little slack
  // absorbs sub-pixel rounding and the last token's growth.
  const BOTTOM_THRESHOLD = 120

  // The scroll container/content only exist once at least one message renders.
  const hasMessages = chat.messages.length > 0

  // Re-arm auto-follow when opening a conversation. Runs before the (async)
  // history load, so the observer below finds `stick` already true and pins the
  // freshly-loaded turns to the bottom.
  useEffect(() => {
    stickToBottomRef.current = true
    setIsAtBottom(true)
    setHasNewBelow(false)
  }, [selectedThreadId])

  // Detach detection — the only thing that turns auto-follow off. Detach only
  // when the scroll moves *up*: we never scroll up ourselves, so an upward move
  // can only be the user. This matters during a flood — content grows every
  // frame while scrollTop still holds last frame's pinned value, and the scroll
  // event fires before the ResizeObserver re-pins (per the HTML rendering-steps
  // order), so a plain distance check would read a huge gap and wrongly detach.
  const lastScrollTopRef = useRef(0)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight
      const movedUp = el.scrollTop < lastScrollTopRef.current - 1
      lastScrollTopRef.current = el.scrollTop
      if (dist <= BOTTOM_THRESHOLD) {
        stickToBottomRef.current = true
        setIsAtBottom(true)
        setHasNewBelow(false)
      } else if (movedUp) {
        stickToBottomRef.current = false
        setIsAtBottom(false)
      }
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
  }, [hasMessages])

  // Auto-follow — the only thing that pins to the bottom. The initial pin runs
  // here (useLayoutEffect, before paint) so freshly-loaded history never flashes
  // scrolled-up. A ResizeObserver then keeps it pinned through every later height
  // change: each streamed token, tool blocks mounting, code highlighting
  // settling, or a banner resizing the list.
  useLayoutEffect(() => {
    const content = contentRef.current
    const el = containerRef.current
    if (!content || !el) return
    if (stickToBottomRef.current) el.scrollTop = el.scrollHeight
    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current) el.scrollTop = el.scrollHeight
      else setHasNewBelow(true)
    })
    observer.observe(content) // scrollHeight grows as messages stream in
    observer.observe(el) // clientHeight shrinks when a banner appears below
    return () => observer.disconnect()
  }, [hasMessages])

  // Re-pin to the bottom and resume auto-follow (the "reattach" action).
  const scrollToBottom = useCallback(() => {
    const el = containerRef.current
    stickToBottomRef.current = true
    setIsAtBottom(true)
    setHasNewBelow(false)
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
  }, [])

  const currentThread = threads.find((t) => t.id === selectedThreadId)
  const noAgents = agents.length === 0

  // Plan is the only sticky mode (reflected in the composer pill). Goal is a
  // one-off per-turn run, so it never leaves the thread "in a mode"; legacy
  // goal threads (mode="goal") are treated as plain chat here.
  const activeMode: ThreadMode = currentThread?.mode === "plan" ? "plan" : "chat"
  // The live run status from the stream (a plan turn's planning/awaiting_approval,
  // or a goal run's running/terminal). Drives the goal run deck + plan-doc open.
  const runView = chat.goalStatus
  // The goal loop is actively executing — offer Stop + the run deck, not chat.
  const goalExecuting = runView?.status === "running"

  // Open (or refresh) PLAN.md in the file panel each time a planning turn parks
  // the thread in review, so the user reads the plan as they iterate. Edge-
  // triggered on entering `awaiting_approval` — covers both the first draft and
  // later refinements.
  const prevStatusRef = useRef<RunStatus | null>(null)
  useEffect(() => {
    const status = runView?.status ?? null
    const prev = prevStatusRef.current
    prevStatusRef.current = status
    if (
      status === "awaiting_approval" &&
      prev !== "awaiting_approval" &&
      workspaceId
    ) {
      requestOpenFile({ workspaceId, path: PLAN_DOC, name: PLAN_DOC })
    }
  }, [runView?.status, workspaceId])

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
        contentRef={contentRef}
        resetKey={selectedThreadId ?? undefined}
        className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-5 [overflow-anchor:none] sm:px-6"
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

      {/* Tasks live in the run deck while a goal executes (below); otherwise
          show them as their own card. */}
      {chat.todos.length > 0 && !goalExecuting && (
        <div className="mx-auto w-full max-w-3xl px-4 pb-1 sm:px-6">
          <ChatTodoList todos={chat.todos} />
        </div>
      )}

      {chat.error ? (
        <p className="px-4 pb-1 text-sm text-destructive">{chat.error}</p>
      ) : null}

      {goalExecuting ? (
        // Autonomous goal execution: one control deck holding live status, task
        // progress, the steer input, stop, and the wait-time game. The embedded
        // composer forces `isSending` false so a message sends immediately
        // (interjects into the loop's next turn) rather than joining the queue.
        <GoalRunPanel
          objective={runView?.condition ?? ""}
          iteration={runView?.iteration ?? 0}
          maxIterations={runView?.maxIterations ?? 0}
          reason={runView?.reason ?? ""}
          todos={chat.todos}
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
        // Plain chat, /ask, or plan planning/review — the composer stays
        // available so the user can iterate. Slash commands + the active-mode
        // pill live in the composer's own toolbar.
        <ChatComposer
          input={draft}
          onInputChange={setDraft}
          onKeyDown={handleKeyDown}
          onSend={() => void handleSend()}
          onStop={chat.stop}
          isSending={chat.isStreaming}
          disabled={noAgents}
          placeholder={
            activeMode === "plan"
              ? "Refine the plan, or exit plan mode (✕) to execute…"
              : "Type a message, or / for commands…"
          }
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          mentionSources={mentionSources}
          queuedMessages={chat.queue}
          queuePaused={chat.queuePaused}
          onRemoveQueued={chat.removeQueued}
          onEditQueued={chat.editQueued}
          onResumeQueue={chat.resumeQueue}
          activeMode={activeMode}
          onExitMode={() => void handleExitMode()}
        />
      )}
    </div>
  )
}
