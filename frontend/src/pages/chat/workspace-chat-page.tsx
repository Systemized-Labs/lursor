import { Lightning, Robot, NotePencil, Sparkle, SquaresFour } from "@phosphor-icons/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useLocation, useSearchParams } from "react-router-dom"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { useStore } from "zustand"
import { useStickToBottom } from "use-stick-to-bottom"

import { useAgents } from "@/api/agents"
import {
  invalidateThreadLists,
  threadsApi,
  useActiveRuns,
  useThread,
  useThreads,
  useUpdateThread,
} from "@/api/threads"
import { useDefaultAgents } from "@/api/settings"
import { useWorkspace } from "@/api/workspaces"
import { useChatEngine } from "@/agui/useChatEngine"
import { ChatStoreProvider } from "@/agui/chatStore"
import { Button } from "@/components/ui/button"
import { AssistantConfirmCard } from "@/components/chat/AssistantConfirmCard"
import { ChatComposer } from "@/components/chat/ChatComposer"
import { ChatTimeline } from "@/components/chat/ChatTimeline"
import { ChatRunDeck } from "@/components/chat/ChatRunDeck"
import { GoalRunPanel } from "@/components/chat/GoalPanel"
import { parseSlashCommand } from "@/components/chat/commands/registry"
import type { AgentScope, CommandAction } from "@/components/chat/commands/types"
import { useWorkspaceChatMentionSources } from "@/components/chat/mentions/sources"
import { useSettingsParam } from "@/components/settings/use-settings-param"
import { requestOpenFile } from "@/lib/open-file"
import {
  consumePendingSendToChat,
  subscribeSendToChat,
} from "@/lib/send-to-chat"
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

interface WorkspaceChatPageProps {
  workspaceId?: string
  /** The open conversation, or null for a new one. */
  threadId: string | null
  /** Report a change of conversation to whoever owns the address. */
  onThreadChange: (threadId: string | null) => void
  /** Report the open conversation's name, for the pane's tab to label itself with. */
  onDetail?: (detail: string | null) => void
  /**
   * Report that this pane is being *used*, not just looked at — which is what
   * promotes a preview tab to one that stays. Sending a turn is the only thing that
   * counts; see `PaneParams.preview`. Absent on mobile, which has no panes.
   */
  onCommit?: () => void
  /**
   * Whether this is the visible chat surface. Hidden chat panes stay mounted
   * (`renderer: "always"` in `pane-kinds.ts`), so a cross-pane request parked for
   * "the chat the user is looking at" (a commit summary) must only be answered by
   * the active one — same visibility guard the Files editor uses (`file-viewer`).
   *
   * Required: PaneContent supplies it on both desktop (the pane's visibility) and
   * mobile (hardcoded — a phone has exactly one chat surface).
   */
  active: boolean
}

/**
 * The chat surface for a workspace. Built on a normalized store + engine
 * ({@link useChatEngine}) and use-stick-to-bottom autoscroll, so streamed tokens
 * re-render only the affected message row and the view pins cleanly to the bottom.
 *
 * A **pane**, not a route, since Phase 4. Which conversation is open arrives as a
 * prop rather than being read from `?c=`, and a change to it is reported back out
 * — because there can be more than one chat pane open, and two of them cannot both
 * be `?c=`. The pane host mirrors whichever one is focused; see `pane-host.tsx`.
 *
 * `?draft=` is still read from the URL, deliberately: that is a one-shot hand-off
 * from elsewhere in the app, not state this surface owns.
 */
export function WorkspaceChatPage({
  workspaceId,
  threadId: cParam,
  onThreadChange,
  onDetail,
  onCommit,
  active,
}: WorkspaceChatPageProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
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
  const isAssistantWorkspace = Boolean(workspace?.is_assistant)
  const agentNameById = useMemo(
    () => new Map(agents.map((a) => [a.id, a.name])),
    [agents]
  )
  const [draft, setDraft] = useState("")
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const mentionSources = useWorkspaceChatMentionSources(workspaceId)
  const { data: defaultAgents } = useDefaultAgents()
  const { openSettings } = useSettingsParam()
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
      invalidateThreadLists(qc, thread.workspace_id)
      onThreadChange(thread.id)
    },
  })
  const {
    store,
    send: engineSend,
    loadConversation,
    reloadMessages,
    startNewConversation,
  } = chat

  /**
   * The engine's `send`, with the pane told it is being used.
   *
   * Wrapped once here rather than at each call site because there are four of them —
   * a plain message, a slash command, the hand-off from the New Agent surface and
   * "Execute plan" — and every one of them means the same thing to a preview tab.
   * `chat.interject` says it too, and calls {@link onCommit} itself below.
   */
  const send: typeof engineSend = useCallback(
    (...args) => {
      onCommit?.()
      return engineSend(...args)
    },
    // Off the destructured member, not `chat`: the engine returns a fresh object each
    // render, and only its members are memoised.
    [engineSend, onCommit]
  )

  // Commit summaries parked by the Changes panel. Only the visible chat pane
  // consumes — hidden panes stay mounted (renderer: "always"), so an unguarded
  // page could swallow the request and send it to a conversation nobody's
  // looking at. The shell focuses a chat pane first; this one — now active —
  // picks the request up.
  useEffect(() => {
    if (!active) return
    const trySend = () => {
      const request = consumePendingSendToChat(workspaceId)
      if (!request) return
      void send(request.text, [])
    }
    trySend()
    return subscribeSendToChat(trySend)
  }, [active, workspaceId, send])


  // Reactive slices of chat state. Each is low-frequency (start/end/settle), so
  // subscribing here never re-renders the page per streamed token.
  const selectedThreadId = useStore(store, (s) => s.selectedThreadId)
  const isStreaming = useStore(store, (s) => s.isStreaming)
  const todos = useStore(store, (s) => s.todos)
  const goalStatus = useStore(store, (s) => s.goalStatus)
  const error = useStore(store, (s) => s.error)
  const queue = useStore(store, (s) => s.queue)
  const queuePaused = useStore(store, (s) => s.queuePaused)
  // Only ever populated by the Assistant's destructive tools, but read
  // unconditionally: a store subscription is cheap, and gating it on the
  // workspace would mean a card published a beat before `workspace` resolves has
  // nowhere to land.
  const confirms = useStore(store, (s) => s.confirms)

  // The open conversation. Normally it is in this workspace's list, but the list is
  // filterable (``list_threads`` can exclude scheduled runs), so fall back to
  // fetching it by id — that route is never filtered. Without this, a thread absent
  // from the list rendered the "New conversation" placeholder instead of its title,
  // offered no rename, and — worse — left the composer's agent picker on the
  // default rather than the agent that actually ran it.
  const listedThread = threads.find((t) => t.id === selectedThreadId)
  const unlistedThread = useThread(
    selectedThreadId && !listedThread ? selectedThreadId : undefined
  ).data
  const currentThread = listedThread ?? unlistedThread

  // Hand the conversation's name to the pane so its tab can wear it instead of
  // "Chat". Reported as it becomes known and as it changes: a fresh conversation
  // has no name until the backend titles it from the first turn (which the
  // list-refresh below picks up), and a rename in the header should reach the tab
  // without a reload. Null while there is no conversation, which is what puts the
  // kind's own label back.
  useEffect(() => {
    onDetail?.(currentThread?.title || null)
  }, [currentThread?.title, onDetail])

  // Scroll instance owned here so send/interject can re-pin to the bottom.
  const stick = useStickToBottom({ resize: "smooth", initial: "instant" })

  // The `threadId` prop is the source of truth for which conversation is open.
  // Same shape as when it came from `?c=`, including the "only reset when it was
  // actually cleared" guard — a prop that is null on the first render is a new
  // conversation, not a request to discard one.
  const prevCParam = useRef(cParam)
  useEffect(() => {
    const cParamCleared = prevCParam.current !== cParam && !cParam
    prevCParam.current = cParam
    if (cParam) {
      if (cParam !== selectedThreadId) void loadConversation(cParam)
    } else if (cParamCleared && selectedThreadId !== null) {
      startNewConversation()
    }
  }, [cParam, selectedThreadId, loadConversation, startNewConversation])

  // When a run settles, refresh the thread list so a background-generated title
  // (auto-naming a new conversation from its first message) replaces the
  // truncated placeholder in the sidebar and header.
  const wasStreaming = useRef(isStreaming)
  useEffect(() => {
    if (wasStreaming.current && !isStreaming && workspaceId) {
      invalidateThreadLists(qc, workspaceId)
    }
    wasStreaming.current = isStreaming
  }, [isStreaming, workspaceId, qc])

  // A prompt arriving from the New Agent home surface: pre-select its agent.
  useEffect(() => {
    const launch = location.state as NewAgentLaunch | null
    if (launch?.agentId) setSelectedAgentId(launch.agentId)
  }, [location.state])

  // Keep the agent picker in sync with the open thread (or defaults for a new one).
  // No special case for the Assistant workspace: any agent works there, and each
  // one picks up the control plane for the duration of the run.
  useEffect(() => {
    if (selectedThreadId) {
      if (currentThread) setSelectedAgentId(currentThread.agent_id)
    } else {
      const chatDefault = defaultAgents?.chat
      const seedable =
        chatDefault && agents.some((a) => a.id === chatDefault)
          ? chatDefault
          : agents[0]?.id
      setSelectedAgentId((prev) => prev || seedable || "")
    }
  }, [selectedThreadId, currentThread, agents, defaultAgents])

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
    void send(text, atts)
  }, [location.state, cParam, agents, selectedAgentId, send])

  // A prompt seeded through the URL (`?draft=`) — e.g. "Author with agent" from
  // the Skills manager. Unlike the hand-off above this never sends: the point is
  // to land mid-sentence with a cursor, not to fire a half-written request. The
  // param is stripped once consumed so a reload (or Back) can't overwrite what
  // has been typed since.
  const draftParam = searchParams.get("draft")
  useEffect(() => {
    if (!draftParam) return
    setDraft(draftParam)
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete("draft")
        return next
      },
      { replace: true }
    )
  }, [draftParam, setSearchParams])

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

  // The agent a turn with no command of its own runs under. Normally the thread's
  // selected agent, but a manual override wins: while a plan is parked the picker
  // only ever sets an override (the parked thread counts as an implicit `/goal`),
  // so without this a plain refinement turn would silently run as the plan agent
  // while the composer showed the one the user had just picked.
  function agentForPlainTurn(): { id: string; name?: string } {
    const id = agentOverride ?? selectedAgentId
    return { id, name: agentNameById.get(id) }
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
    onThreadChange(null)
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
        // A partial compaction (the agent's ratio is below 100%) leaves the newest
        // turns in place, so say what it actually did rather than implying the
        // whole thread collapsed.
        toast.success(
          res.kept
            ? `Compacted ${res.summarized} messages, kept the last ${res.kept}`
            : "Conversation compacted",
          { id: toastId }
        )
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
      let turnAgent = agentForPlainTurn()
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
          await send(args, atts, command.turnIntent ?? "chat", undefined, turnAgent)
          return
        case "action":
          if (command.action) await runCommandAction(command.action)
          return
      }
    }
    // A plain message sends a normal `chat` turn. When a plan is parked the
    // backend treats that turn as a refinement of the plan doc (not an
    // implementation); the user presses "Execute plan" to carry it out.
    await send(text, atts, "chat", undefined, agentForPlainTurn())
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
    // Steering a running turn is using the pane as much as starting one is.
    onCommit?.()
    await chat.interject(text)
  }

  function handleInterjectKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void handleInterject()
    }
  }

  const noAgents = agents.length === 0
  const confirmCards = useMemo(() => Object.values(confirms), [confirms])

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
    await send("Execute plan", [], "execute_plan", undefined, resolved)
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
        {/* Header. One height, one tone, on every platform. It used to grow to
            44px and take `bg-sidebar` on macOS — and inset 26px when the sidebar
            was down to its rail — because collapsing the sidebar put this row
            under the traffic lights. The WindowBar reserves that band above the
            whole shell now, so this is an ordinary content header again. */}
        <div className="flex h-9 shrink-0 items-center gap-3 bg-background/70 px-3 backdrop-blur-sm">
          {/* No conversation name here. The tab carries it (`pane-tab.tsx`), and
              printing it again one line below the tab that just said it spent a
              row on nothing. Renaming moved with it: the sidebar row's menu owns
              that now, via `workspace-dialogs.tsx`. */}
          <div className="flex min-w-0 flex-1 items-center gap-2">
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
            {/* A skill written here lands in the catalog assigned to nothing.
                Keep the place that fixes that one click away. */}
            {workspace?.is_system ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => openSettings("capabilities")}
                title="Manage and assign skills — new ones land unassigned"
              >
                <SquaresFour className="h-4 w-4" />
                <span className="hidden sm:inline">Manage skills</span>
              </Button>
            ) : null}
          </div>
        </div>

        <ChatTimeline
          instance={stick}
          resetKey={selectedThreadId ?? undefined}
          empty={
            <div className="flex h-full items-center justify-center">
              <div className="space-y-3 text-center">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/15">
                  {isAssistantWorkspace ? (
                    <Lightning weight="fill" className="h-7 w-7 text-primary" />
                  ) : workspace?.is_system && !noAgents ? (
                    <Sparkle className="h-7 w-7 text-primary" />
                  ) : (
                    <Robot className="h-7 w-7 text-primary" />
                  )}
                </div>
                {/* The studio is a directory of skills, which an empty chat does
                    nothing to convey. Say what this place can do, and where the
                    result of doing it shows up. */}
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-foreground">
                    {isAssistantWorkspace
                      ? "Assistant"
                      : noAgents
                        ? "No agents yet"
                        : workspace?.is_system
                          ? "Skill Studio"
                          : "Start the conversation"}
                  </p>
                  <p className="mx-auto max-w-[18rem] text-xs text-muted-foreground">
                    {isAssistantWorkspace
                      ? "Whichever agent you pick here can run Lursor itself: create workspaces, retarget another agent's model, set up schedules, start work in any project, and tell you what everything is costing. Deletes always stop and ask first."
                      : noAgents
                        ? "Create an agent in Settings → Capabilities to start chatting."
                        : workspace?.is_system
                          ? "Ask for a skill and it gets written into your catalog — SKILL.md, references and scripts. Every existing skill is in the file tree to crib from, and the terminal runs their scripts."
                          : "Pick an agent above and send the first message."}
                  </p>
                  {workspace?.is_system && !noAgents ? (
                    <p className="mx-auto max-w-[18rem] pt-1 text-xs text-muted-foreground">
                      New skills arrive unassigned — pick where they apply in{" "}
                      <button
                        type="button"
                        onClick={() => openSettings("capabilities")}
                        className="font-medium text-foreground underline underline-offset-2"
                      >
                        Skills
                      </button>
                      .
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          }
        />

        {/* The Assistant's stop-and-ask cards. Directly above the composer
            rather than inline in the timeline: the run is genuinely blocked on
            one, so it belongs where the user's attention already is, not
            wherever the transcript happened to scroll to. */}
        {confirmCards.length ? (
          <div className="space-y-2 px-4 pb-2">
            {confirmCards.map((confirm) => (
              <AssistantConfirmCard key={confirm.token} confirm={confirm} />
            ))}
          </div>
        ) : null}

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
                isAssistantWorkspace
                  ? "Ask the Assistant to do something…"
                  : isParked
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
