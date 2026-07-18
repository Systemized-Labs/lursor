import { NotePencil, Question, Target, type Icon } from "@phosphor-icons/react"

import { cn } from "@/lib/utils"
import { renderWithIcons } from "@/lib/emoji-icons"
import type { ChatMessage } from "@/agui/types"
import type { MessageKind } from "@/api/types"

/** Per-turn history badge presentation. "chat" (a plain message) has no badge. */
const KIND_BADGE: Partial<Record<MessageKind, { label: string; Icon: Icon }>> = {
  ask: { label: "Ask", Icon: Question },
  plan: { label: "Plan", Icon: NotePencil },
  goal: { label: "Goal", Icon: Target },
}

/** A small pill on a user bubble recording how the turn was sent (/ask, /plan,
 *  /goal). Renders nothing for a plain chat turn. */
function MessageKindBadge({ kind }: { kind?: MessageKind }) {
  const meta = kind ? KIND_BADGE[kind] : undefined
  if (!meta) return null
  const { label, Icon } = meta
  return (
    <span className="mb-1.5 inline-flex items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
      <Icon className="h-3 w-3" />
      {label}
    </span>
  )
}

/** A user turn: a subtle, unshadowed card so the prompt is distinguishable
 *  without breaking the document flow. */
export function UserBubble({ message }: { message: ChatMessage }) {
  const hasAttachments = message.attachments && message.attachments.length > 0
  return (
    <div className="group animate-in fade-in-0 slide-in-from-bottom-1 duration-300">
      <div className="rounded-xl border border-border/60 bg-muted/25 px-4 py-2.5 text-[0.9375rem] leading-relaxed text-foreground">
        <MessageKindBadge kind={message.kind} />
        {hasAttachments && (
          <div
            className={cn("flex flex-wrap gap-2", message.content !== "" && "mb-2")}
          >
            {message.attachments!.map((att, i) => (
              <a
                key={`${att.url}-${i}`}
                href={att.url}
                target="_blank"
                rel="noreferrer"
                title={att.name}
                className="block overflow-hidden rounded-lg border border-border/60"
              >
                <img
                  src={att.url}
                  alt={att.name ?? "attachment"}
                  className="max-h-48 max-w-[16rem] object-cover"
                />
              </a>
            ))}
          </div>
        )}
        {message.content !== "" && (
          <p className="whitespace-pre-wrap leading-relaxed break-words">
            {renderWithIcons(message.content, message.id)}
          </p>
        )}
      </div>
    </div>
  )
}
