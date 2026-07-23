import { memo, useState } from "react"
import { ArrowsInLineVertical, Check, Copy } from "@phosphor-icons/react"
import { useStore } from "zustand"
import { useShallow } from "zustand/react/shallow"

import { copyToClipboard } from "@/lib/utils"
import {
  ChatSubagentCalls,
  SUBAGENT_TOOL_NAME,
} from "@/components/chat/ChatSubagentCalls"
import { ChatFilesChanged } from "@/components/chat/ChatFilesChanged"
import { useChatMessage, useChatStoreApi } from "@/agui/chatStore"
import type { ChatMessage } from "@/agui/types"

import { StreamingText } from "./StreamingText"

/** A message carries something to show inline (answer text or a subagent call).
 *  Reasoning is intentionally excluded — agent thoughts are hidden from the UI.
 *  Regular tool calls are excluded too: they render in the bottom tool-activity
 *  bar, not the transcript, so text reads cleanly. */
function hasBody(m: ChatMessage | undefined): boolean {
  return Boolean(
    m &&
      (m.content !== "" ||
        m.toolCalls.some((t) => t.name === SUBAGENT_TOOL_NAME))
  )
}

/** Hover action that copies a settled turn's text to the clipboard. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        copyToClipboard(text).then((ok) => {
          if (!ok) return
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      title={copied ? "Copied" : "Copy"}
      aria-label="Copy message"
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  )
}

/**
 * One assistant turn (agent loop step). Subscribes to just this message, so a
 * streamed token re-renders only the active segment — settled siblings, the
 * group, and the timeline are untouched.
 */
const AssistantSegment = memo(function AssistantSegment({
  id,
  first,
}: {
  id: string
  first: boolean
}) {
  const seg = useChatMessage(id)
  if (!hasBody(seg) || !seg) return null

  // A `/compact` digest stands in for the messages it condensed — render it as a
  // distinct, bordered card rather than a normal reply so the seam is obvious.
  if (seg.kind === "summary") {
    return (
      <div className={first ? undefined : "mt-3"}>
        <div className="rounded-xl border border-border/60 bg-muted/30 px-4 py-3">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <ArrowsInLineVertical className="h-3.5 w-3.5" />
            Conversation summarized
          </div>
          <StreamingText text={seg.content} streaming={false} />
        </div>
      </div>
    )
  }

  const subagentCalls = seg.toolCalls.filter((t) => t.name === SUBAGENT_TOOL_NAME)
  return (
    <div className={first ? undefined : "mt-3"}>
      {seg.content !== "" && (
        <StreamingText text={seg.content} streaming={Boolean(seg.streaming)} />
      )}
      {subagentCalls.length > 0 && (
        <div className={seg.content !== "" ? "mt-3" : undefined}>
          <ChatSubagentCalls calls={subagentCalls} />
        </div>
      )}
    </div>
  )
})

/** Settled-turn footer: files-changed summary + copy. Subscribes to the group's
 *  messages with a shallow compare so it only re-renders when a message identity
 *  changes (never mid-stream — it isn't rendered until the run settles). */
function AssistantFooter({ ids }: { ids: string[] }) {
  const store = useChatStoreApi()
  const messages = useStore(
    store,
    useShallow((s) => ids.map((id) => s.byId[id]).filter(Boolean) as ChatMessage[])
  )
  const copyText = messages
    .map((m) => m.content)
    .filter((c) => c !== "")
    .join("\n\n")
  return (
    <>
      <ChatFilesChanged messages={messages} />
      {copyText.trim() !== "" && (
        <div className="-ml-1.5 mt-1.5 flex items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <CopyButton text={copyText} />
        </div>
      )}
    </>
  )
}

/**
 * A run of consecutive assistant turns rendered as one flowing document block,
 * mirroring how the run persists (one assistant message) on reload. No
 * bubble/avatar — the transcript reads like a document. Subscribes only to
 * derived booleans (is any message streaming / does any have a body), so token
 * updates flow to the individual {@link AssistantSegment}s, not here.
 */
export const AssistantGroup = memo(function AssistantGroup({
  ids,
}: {
  ids: string[]
}) {
  const store = useChatStoreApi()
  const isStreaming = useStore(store, (s) => ids.some((id) => s.byId[id]?.streaming))
  const bodyShown = useStore(store, (s) => ids.some((id) => hasBody(s.byId[id])))

  // Nothing to show inline yet (streaming, no text/subagent) — the working dots
  // and live tool ticker live in the bottom activity cluster, not the transcript.
  if (isStreaming && !bodyShown) return null

  return (
    <div className="group animate-in fade-in-0 slide-in-from-bottom-1 duration-300">
      <div className="min-w-0 text-sm text-foreground">
        {ids.map((id, i) => (
          <AssistantSegment key={id} id={id} first={i === 0} />
        ))}
        {!isStreaming && <AssistantFooter ids={ids} />}
      </div>
    </div>
  )
})
