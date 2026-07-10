import { Wrench } from "lucide-react"

import { cn } from "@/lib/utils"
import type { ChatMessage, ChatToolCall } from "@/agui/types"
import { Badge } from "@/components/ui/badge"

function ToolCallView({ toolCall }: { toolCall: ChatToolCall }) {
  return (
    <div className="rounded-md border bg-background/50 p-3 text-left">
      <div className="flex items-center gap-2">
        <Wrench className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium text-foreground">
          {toolCall.name}
        </span>
      </div>
      {toolCall.args ? (
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
          {toolCall.args}
        </pre>
      ) : null}
      {toolCall.result !== undefined ? (
        <div className="mt-2 border-t pt-2">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            Result
          </span>
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words text-xs text-foreground">
            {toolCall.result}
          </pre>
        </div>
      ) : null}
    </div>
  )
}

export function ChatMessageItem({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user"
  const roleLabel =
    message.role === "user"
      ? "You"
      : message.role === "assistant"
        ? "Assistant"
        : message.role

  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "flex max-w-[85%] flex-col gap-2 rounded-lg px-4 py-3 text-sm",
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-foreground"
        )}
      >
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "text-xs font-medium",
              isUser ? "text-primary-foreground/80" : "text-muted-foreground"
            )}
          >
            {roleLabel}
          </span>
          {message.streaming ? (
            <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
              streaming
            </Badge>
          ) : null}
        </div>

        {message.content ? (
          <p className="whitespace-pre-wrap break-words">{message.content}</p>
        ) : message.toolCalls.length === 0 && message.streaming ? (
          <p className="text-muted-foreground">…</p>
        ) : null}

        {message.toolCalls.length > 0 ? (
          <div className="flex flex-col gap-2">
            {message.toolCalls.map((toolCall) => (
              <ToolCallView key={toolCall.id} toolCall={toolCall} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}
