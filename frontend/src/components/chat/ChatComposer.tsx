import { useRef, type KeyboardEvent } from "react"
import { Send, Square } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { MentionMenu } from "@/components/chat/mentions/MentionMenu"
import { useMentions } from "@/components/chat/mentions/use-mentions"
import type { MentionSource, ResolvedMention } from "@/components/chat/mentions/types"

const NOOP_SOURCES: MentionSource[] = []

export interface ChatComposerProps {
  input: string
  onInputChange: (value: string) => void
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void
  onSend: () => void
  onStop: () => void
  isSending: boolean
  /** Disables the whole composer (e.g. no thread). */
  disabled?: boolean
  placeholder?: string
  /** Categories offered by the `@` reference menu. Menu is inert if empty. */
  mentionSources?: MentionSource[]
  /** Called when the user commits a mention (for optional backend resolution). */
  onMentionAdd?: (mention: ResolvedMention) => void
}

/** Message composer: a growing textarea inside a rounded card, with send/stop
 *  and an `@` reference menu anchored above it. */
export function ChatComposer({
  input,
  onInputChange,
  onKeyDown,
  onSend,
  onStop,
  isSending,
  disabled,
  placeholder = "Type a message…",
  mentionSources,
  onMentionAdd,
}: ChatComposerProps) {
  const hasContent = !!input.trim()
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const mentions = useMentions({
    value: input,
    setValue: onInputChange,
    textareaRef,
    sources: mentionSources ?? NOOP_SOURCES,
    onResolve: onMentionAdd,
    enabled: (mentionSources?.length ?? 0) > 0,
  })

  // The mention menu claims arrows/enter/tab/escape first; only if it doesn't
  // handle the key does the parent's send-on-enter logic run.
  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (mentions.onKeyDown(e)) return
    onKeyDown(e)
  }

  return (
    <div className="px-4 pb-4 pt-2 flex-shrink-0">
      <div className="relative">
        <MentionMenu
          open={mentions.open}
          rows={mentions.rows}
          mode={mentions.mode}
          category={mentions.category}
          loading={mentions.loading}
          activeIndex={mentions.activeIndex}
          onHover={mentions.setActiveIndex}
          onSelect={mentions.selectRow}
        />
        <div
          className={cn(
            "flex items-center gap-1.5 rounded-2xl border border-transparent bg-muted/50 px-2.5 py-2 shadow-sm",
            "transition-[border-color,box-shadow,background-color] duration-200",
            "focus-within:border-ring/30 focus-within:bg-background focus-within:shadow-md focus-within:ring-2 focus-within:ring-ring/15",
            disabled && "opacity-60"
          )}
        >
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              onInputChange(e.target.value)
              mentions.refresh()
            }}
            onKeyDown={handleKeyDown}
            onKeyUp={mentions.refresh}
            onClick={mentions.refresh}
            onSelect={mentions.refresh}
            placeholder={placeholder}
            disabled={disabled}
            rows={1}
            className={cn(
              "min-h-[34px] max-h-44 resize-none border-0 bg-transparent px-1 py-1.5 text-sm leading-relaxed shadow-none",
              "focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent disabled:bg-transparent dark:disabled:bg-transparent"
            )}
          />
          {isSending ? (
            <Button
              onClick={onStop}
              variant="destructive"
              size="icon"
              title="Stop"
              className="h-8 w-8 flex-shrink-0 rounded-full"
            >
              <Square className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              onClick={onSend}
              disabled={disabled || !hasContent}
              size="icon"
              title="Send"
              className={cn(
                "h-8 w-8 flex-shrink-0 rounded-full transition-transform duration-150",
                hasContent && !disabled && "hover:scale-105 active:scale-95"
              )}
            >
              <Send className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
