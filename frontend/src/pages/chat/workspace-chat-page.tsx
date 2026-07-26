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
  threadsApi,
  useActiveRuns,
  useThreads,
  useUpdateThread,
} from "@/api/threads"
import { useDefaultAgents } from "@/api/settings"
import { useWorkspace } from "@/api/workspaces"
import { useChatEngine } from "@/agui/useChatEngine"
import { ChatStoreProvider } from "@/agui/chatStore"
import { Button } from "@/components/ui/button"
import { ChatComposer } from "@/components/chat/ChatComposer"
import { ChatTimeline } from "@/components/chat/ChatTimeline"
import { ChatRunDeck } from "@/components/chat/ChatRunDeck"
import { GoalRunPanel } from "@/components/chat/GoalPanel"
import { parseSlashCommand } from "@/components/chat/commands/registry"
import type { AgentScope, CommandAction } from "@/components/chat/commands/types"
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
  const agentNameById = useMemo(
    () => new Map(agents.map((a) => [a.id, a.name])),
    [agents]
  )
  const [isEditingTitle, setIsEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState("")
  const [draft, setDraft] = useState("")
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const mentionSources = useWorkspaceChatMentionSources(workspaceId)
  const { data: defaultAgents } = useDefaultAgents()

  // A manual per-turn override of the agent a queued slash command would switch
  // to. Null unless the user picks a different agent from the composer while a
  // command is in the draft; reset whenever the draft's command changes so it
  // never leaks past the turn it was chosen for.
  const [agentOverride, setAgentOverride] = useState<string | null>(null)

  // The `agentKey` of the slash command currently in the draft (if any) — the
  // mode whose default agent this send would switch to.
  const pendingKey = useMemo<keyof DefaultAgentsSettings | null>(
    () => parseSlashCommand(draft)?.command.agentKey ?? null,
    [draft]
  )

  const chat = useChatEngine({
    workspaceId,
    agentId: selectedAgentId || undefined,
    agentName: agentNameById.get(selectedAgentId),
    activeRuns,
    reconnect: true,
    onThreadCreated: (thread) => {
      qc.invalidateQueries({ queryKey: threadKeys.byWorkspace(thread.workspace_id) })
      setSearchParams({ c: thread.id }, { replace: true })
    },
  })
  const { store, loadConversation, reloadMessages, startNewConversation } = chat

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

  // When a run settles, refresh the thread list so a background-generated title
  // (auto-naming a new conversation from its first message) replaces the
  // truncated placeholder in the sidebar and header.
  const wasStreaming = useRef(isStreaming)
  useEffect(() => {
    if (wasStreaming.current && !isStreaming && workspaceId) {
      qc.invalidateQueries({ queryKey: threadKeys.byWorkspace(workspaceId) })
    }
    wasStreaming.current = isStreaming
  }, [isStreaming, workspaceId, qc])

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

  // Switch the active agent and persist it to the open thread. Returns whether
  // the change stuck: on a failed PATCH we revert the local selection (so the
  // picker never diverges from the backend) and report `false` so callers can
  // abort a send rather than run it under the wrong agent.
  async function handleAgentChange(agentId: string): Promise<boolean> {
    const prev = selectedAgentId
    setSelectedAgentId(agentId)
    if (selectedThreadId) {
      try {
        await updateThread.mutateAsync({
          id: selectedThreadId,
          input: { agent_id: agentId },
        })
      } catch (err) {
        setSelectedAgentId(prev)
        toast.error(err instanceof Error ? err.message : "Failed to switch agent")
        return false
      }
    }
    return true
  }

  function defaultAgentFor(key: keyof DefaultAgentsSettings): string | undefined {
    const id = defaultAgents?.[key]
    return id && agents.some((a) => a.id === id) ? id : undefined
  }

  // Resolve the agent a command runs under. A manual per-turn override wins over
  // the command's default and never persists — it's a turn-only choice. Without
  // one, a sticky (`"thread"`) command persists its default agent to the open
  // thread so later turns reuse it; a one-off (`"turn"`) command leaves the
  // thread's agent untouched and just overrides this turn (the id rides on the
  // wire for the backend to honor once). Returns the `{ id, name }` to send the
  // turn as, or `null` if a required persist failed (caller should abort).
  async function agentForCommand(
    key: keyof DefaultAgentsSettings,
    scope: AgentScope
  ): Promise<{ id: string; name?: string } | null> {
    const target = agentOverride ?? defaultAgentFor(key)
    const runId = target ?? selectedAgentId
    if (scope === "thread" && !agentOverride && target && target !== selectedAgentId) {
      if (!(await handleAgentChange(target))) return null
    }
    return { id: runId, name: agentNameById.get(runId) }
  }

  // The composer's agent picker. While a slash command is queued — or a plan is
  // parked for review (an implicit `/goal`) — picking an agent other than that
  // command's default overrides it for this one turn (never persisted); picking
  // the default clears the override. Otherwise it's a normal agent switch that
  // persists to the open thread.
  function handlePickerAgentChange(agentId: string) {
    if (effectivePendingKey) {
      const commandDefault = defaultAgentFor(effectivePendingKey)
      setAgentOverride(agentId === commandDefault ? null : agentId)
      return
    }
    void handleAgentChange(agentId)
  }

  function handleNewConversation() {
    const chatDefault = defaultAgentFor("chat")
    if (chatDefault) setSelectedAgentId(chatDefault)
    setSearchParams({})
  }

  // Condense the open conversation into a single summary, then reload so the
  // timeline shows the summary in place of the messages it subsumed.
  async function handleCompact() {
    const threadId = selectedThreadId
    if (!threadId) {
      toast.error("Nothing to compact yet")
      return
    }
    if (isStreaming) {
      toast.error("Can't compact while the agent is working")
      return
    }
    const toastId = toast.loading("Compacting conversation…")
    try {
      const res = await threadsApi.compact(threadId)
      if (res.compacted) {
        await reloadMessages()
        toast.success("Conversation compacted", { id: toastId })
      } else {
        toast.info(res.reason ?? "Nothing to compact", { id: toastId })
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to compact", {
        id: toastId,
      })
    }
  }

  async function runCommandAction(action: CommandAction) {
    if (action === "new-conversation") handleNewConversation()
    else if (action === "compact") await handleCompact()
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
      // Annotated to match agentForCommand's return type, which leaves `name`
      // optional — inference from this initializer alone would make it required.
      let turnAgent: { id: string; name?: string } = {
        id: selectedAgentId,
        name: agentNameById.get(selectedAgentId),
      }
      if (command.agentKey) {
        // A sticky command (`/plan`) persists its agent to the thread here; a
        // one-off command (`/ask`, `/goal`) just picks the agent to run this turn
        // under — the id rides on the send for the backend to honor once, without
        // reassigning the thread. Abort if a required persist failed.
        const resolved = await agentForCommand(
          command.agentKey,
          command.agentScope ?? "turn"
        )
        if (!resolved) {
          setDraft(text)
          return
        }
        turnAgent = resolved
      }
      switch (command.kind) {
        case "turn-intent":
          await chat.send(args, atts, command.turnIntent ?? "chat", undefined, turnAgent)
          return
        case "action":
          if (command.action) await runCommandAction(command.action)
          return
      }
    }
    // A plain message sends a normal `chat` turn. When a plan is parked the
    // backend treats that turn as a refinement of the plan doc (not an
    // implementation); the user presses "Execute plan" to carry it out.
    await chat.send(text, atts, "chat", undefined, {
      id: selectedAgentId,
      name: agentNameById.get(selectedAgentId),
    })
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

  // A `/plan` turn parks the thread in `awaiting_approval` with a plan doc. While
  // parked, plain messages refine the doc and an "Execute plan" button carries it
  // out as a goal. Two sources of the parked state (live event; persisted thread),
  // matching the plan-doc auto-open effect below.
  const isParked =
    runView?.status === "awaiting_approval" ||
    (currentThread?.status === "awaiting_approval" && !!currentThread?.plan_path)
  const planPath = runView?.planPath || currentThread?.plan_path || undefined

  // The command whose default agent this send/execute would run under: a queued
  // slash command if one is in the draft, otherwise `/goal` while a plan is parked
  // for review (the "Execute plan" button runs the plan as a one-off goal). Treating
  // parked as an implicit `/goal` lets the composer's agent picker override the
  // execute agent per-turn — a turn-only choice that never touches the parked
  // thread's own agent — instead of persisting a normal agent switch.
  const effectivePendingKey: keyof DefaultAgentsSettings | null =
    pendingKey ?? (isParked ? "goal" : null)

  // Drop a stale override whenever the effective command changes (a queued command
  // clearing on send, or leaving plan review) so an override applies to one turn.
  const prevPendingKey = useRef(effectivePendingKey)
  useEffect(() => {
    if (prevPendingKey.current !== effectivePendingKey) {
      prevPendingKey.current = effectivePendingKey
      setAgentOverride(null)
    }
  }, [effectivePendingKey])

  // The agent this send/execute will actually run under: the manual override if
  // set, otherwise the effective command's default. Drives the composer picker's
  // value and its "→ Name" preview so the coupling stays visible (and any override
  // is reflected) before sending or pressing "Execute plan".
  const pendingAgentId = useMemo(() => {
    if (!effectivePendingKey) return null
    const target = agentOverride ?? defaultAgents?.[effectivePendingKey]
    return target && agentNameById.has(target) ? target : null
  }, [effectivePendingKey, agentOverride, defaultAgents, agentNameById])

  const pendingAgentName = useMemo(() => {
    if (!pendingAgentId || pendingAgentId === selectedAgentId) return null
    return agentNameById.get(pendingAgentId) ?? null
  }, [pendingAgentId, selectedAgentId, agentNameById])

  // Carry the approved plan out as a goal. The visible "Execute plan" turn reads
  // cleanly in the transcript; the backend ignores its text and seeds the goal
  // loop from the plan doc's Success Criteria instead.
  async function handleExecutePlan() {
    void stick.scrollToBottom()
    // Executing a plan runs it as a one-off goal, so run under the `/goal` default
    // agent (if one is set) for this turn only — a per-turn override that leaves
    // the parked thread's own agent untouched. With no `/goal` default, keep the
    // current (plan) agent.
    const resolved = await agentForCommand("goal", "turn")
    if (!resolved) return
    // Execution context is kept clean on the backend: the goal loop is seeded from
    // the plan doc alone (not the planning transcript), so the refinement chatter
    // never reaches the model. The client just sends the turn — no transcript
    // surgery. The planning conversation stays visible in scrollback.
    await chat.send("Execute plan", [], "execute_plan", undefined, resolved)
  }

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

        {error ? (
          <p className="px-4 pb-1 text-sm text-destructive">{error}</p>
        ) : null}

        {/* Unified run deck: task list, live tool activity, and running
            terminals in one bounded, collapsible strip above the composer, so
            streaming chat always keeps priority. Tasks live in the goal panel
            while a goal executes. */}
        <ChatRunDeck
          workspaceId={workspaceId}
          todos={todos}
          goalExecuting={goalExecuting}
        />

        {goalExecuting ? (
          <GoalRunPanel
            objective={runView?.condition ?? ""}
            planName={planPath ? baseName(planPath) : undefined}
            iteration={runView?.iteration ?? 0}
            maxIterations={runView?.maxIterations ?? 0}
            reason={runView?.reason ?? ""}
            todos={todos}
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
          <>
            {isParked && !isStreaming && (
              <div className="mb-1 px-4">
                <div className="mx-auto flex w-full max-w-3xl items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5 sm:px-6">
                  <NotePencil className="h-4 w-4 shrink-0 text-primary" />
                  <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                    Plan ready for review
                    {planPath ? (
                      <span className="text-foreground"> · {baseName(planPath)}</span>
                    ) : null}
                    . Send a message to refine it, or execute it as a goal.
                  </p>
                  <Button
                    size="sm"
                    className="h-7 shrink-0"
                    onClick={() => void handleExecutePlan()}
                    disabled={noAgents}
                  >
                    Execute plan
                  </Button>
                </div>
              </div>
            )}
            <ChatComposer
              input={draft}
              onInputChange={setDraft}
              onKeyDown={handleKeyDown}
              onSend={() => void handleSend()}
              onStop={chat.stop}
              isSending={isStreaming}
              disabled={noAgents}
              placeholder={
                isParked
                  ? "Refine the plan, or press Execute plan to run it…"
                  : "Type a message, or / for commands…"
              }
              attachments={attachments}
              onAttachmentsChange={setAttachments}
              mentionSources={mentionSources}
              queuedMessages={queue}
              queuePaused={queuePaused}
              onRemoveQueued={chat.removeQueued}
              onEditQueued={chat.editQueued}
              onResumeQueue={chat.resumeQueue}
              agents={noAgents ? undefined : agents}
              selectedAgentId={selectedAgentId}
              onAgentChange={handlePickerAgentChange}
              pendingAgentName={pendingAgentName}
              pendingAgentId={pendingAgentId}
            />
          </>
        )}
      </div>
    </ChatStoreProvider>
  )
}
