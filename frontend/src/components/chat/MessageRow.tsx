import { memo } from "react"

import { useChatMessage } from "@/agui/chatStore"

import { UserBubble } from "./UserBubble"
import { AssistantGroup } from "./AssistantGroup"

/** A single (non-grouped) message in a turn's user slot. Subscribes to just this
 *  message; a user turn never changes after send, so it never re-renders once
 *  mounted. Routes by role so a stray non-user message still renders sensibly. */
export const MessageRow = memo(function MessageRow({ id }: { id: string }) {
  const message = useChatMessage(id)
  if (!message) return null
  if (message.role === "user") return <UserBubble message={message} />
  return <AssistantGroup ids={[id]} />
})
