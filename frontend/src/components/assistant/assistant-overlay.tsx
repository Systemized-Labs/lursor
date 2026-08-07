import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Lightning, Plus } from "@phosphor-icons/react"
import { useStore } from "zustand"
import { useStickToBottom } from "use-stick-to-bottom"

import { assistantApi, useAssistantThread } from "@/api/assistant"
import { ChatStoreProvider } from "@/agui/chatStore"
import { useChatEngine } from "@/agui/useChatEngine"
import { AssistantConfirmCard } from "@/components/chat/AssistantConfirmCard"
import { ChatComposer } from "@/components/chat/ChatComposer"
import { ChatTimeline } from "@/components/chat/ChatTimeline"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"

/**
 * The Assistant, as a global panel.
 *
 * Deliberately thin: everything below the dialog frame is the ordinary chat
 * stack (`useChatEngine` → `ChatStoreProvider` → `ChatTimeline` +
 * `ChatComposer`), because an Assistant conversation *is* an ordinary thread on
 * the backend. The only two differences the user sees are that it is reachable
 * from anywhere, and that it has no agent picker — there is exactly one agent it
 * could be, so `embedded` (which hides the picker) is the right composer mode.
 */
export function AssistantOverlay({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  // The thread is created server-side on first read, so this only fires once the
  // overlay has actually been opened — loading the app shouldn't write a row.
  const { data: thread } = useAssistantThread(open)
  const [draft, setDraft] = useState("")
  const stick = useStickToBottom()

  const chat = useChatEngine({
    workspaceId: thread?.workspace_id,
    agentId: thread?.agent_id,
    agentName: "Assistant",
    reconnect: true,
  })

  const { store, loadConversation } = chat
  const loadedRef = useRef<string | null>(null)

  // Open the conversation once per thread id. `loadConversation` bails on a
  // repeat of the same thread, but guarding here keeps the overlay from firing
  // a request on every re-render while it is open.
  useEffect(() => {
    if (!open || !thread || loadedRef.current === thread.id) return
    loadedRef.current = thread.id
    void loadConversation(thread.id)
  }, [open, thread, loadConversation])

  const startFresh = useCallback(async () => {
    const next = await assistantApi.newThread()
    loadedRef.current = next.id
    await loadConversation(next.id)
  }, [loadConversation])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[min(80vh,44rem)] max-w-3xl flex-col gap-0 overflow-hidden p-0"
        data-browser-bounds
      >
        <ChatStoreProvider value={store}>
          <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <Lightning weight="fill" className="h-4 w-4 shrink-0 text-primary" />
            <DialogTitle className="flex-1 text-sm font-semibold text-foreground">
              Assistant
            </DialogTitle>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => void startFresh()}
              title="Start a new Assistant conversation"
            >
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">New</span>
            </Button>
          </header>

          <AssistantBody
            chat={chat}
            draft={draft}
            setDraft={setDraft}
            stick={stick}
            ready={Boolean(thread)}
          />
        </ChatStoreProvider>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Split out so it can subscribe to the store: hooks reading the chat store have
 * to run *inside* the provider, and the overlay shell owns the provider.
 */
function AssistantBody({
  chat,
  draft,
  setDraft,
  stick,
  ready,
}: {
  chat: ReturnType<typeof useChatEngine>
  draft: string
  setDraft: (value: string) => void
  stick: ReturnType<typeof useStickToBottom>
  ready: boolean
}) {
  const { store } = chat
  const isStreaming = useStore(store, (s) => s.isStreaming)
  const error = useStore(store, (s) => s.error)
  const confirms = useStore(store, (s) => s.confirms)

  // Newest last, so a fresh card lands nearest the composer where the user's
  // attention already is.
  const cards = useMemo(() => Object.values(confirms), [confirms])

  const send = useCallback(async () => {
    const text = draft.trim()
    if (!text || !ready) return
    setDraft("")
    stick.scrollToBottom()
    await chat.send(text)
  }, [draft, ready, setDraft, stick, chat])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault()
        void send()
      }
    },
    [send]
  )

  return (
    <>
      <ChatTimeline
        instance={stick}
        empty={
          <div className="flex h-full items-center justify-center">
            <div className="space-y-3 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/15">
                <Lightning weight="fill" className="h-7 w-7 text-primary" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-semibold text-foreground">Assistant</p>
                <p className="mx-auto max-w-[22rem] text-xs text-muted-foreground">
                  Ask it to run Lursor. It can create workspaces, retarget another
                  agent&rsquo;s model, set up schedules, start work in any project,
                  and tell you what everything is costing.
                </p>
              </div>
            </div>
          </div>
        }
      />

      {cards.length ? (
        <div className="space-y-2 px-4 pb-2">
          {cards.map((confirm) => (
            <AssistantConfirmCard key={confirm.token} confirm={confirm} />
          ))}
        </div>
      ) : null}

      {error ? <p className="px-4 pb-1 text-sm text-destructive">{error}</p> : null}

      <ChatComposer
        input={draft}
        onInputChange={setDraft}
        onKeyDown={onKeyDown}
        onSend={() => void send()}
        onStop={chat.stop}
        isSending={isStreaming}
        disabled={!ready}
        placeholder="Ask the Assistant to do something…"
        embedded
      />
    </>
  )
}
