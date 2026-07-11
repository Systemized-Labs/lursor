import { useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react"
import { Paperclip, Send, Square, X } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { MentionMenu } from "@/components/chat/mentions/MentionMenu"
import { useMentions } from "@/components/chat/mentions/use-mentions"
import type { MentionSource, ResolvedMention } from "@/components/chat/mentions/types"
import type { PendingAttachment } from "@/agui/types"

const NOOP_SOURCES: MentionSource[] = []

/** Read an image File into a staged attachment (data URL for preview + raw
 *  base64 payload for the wire). */
async function fileToAttachment(file: File): Promise<PendingAttachment> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
  return {
    id: crypto.randomUUID(),
    name: file.name || "image",
    mimeType: file.type || "image/png",
    dataUrl,
    base64: dataUrl.split(",", 2)[1] ?? "",
  }
}

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
  /** Images staged for the next message. */
  attachments?: PendingAttachment[]
  /** Called when the staged attachment set changes (add/remove). */
  onAttachmentsChange?: (next: PendingAttachment[]) => void
  /** Categories offered by the `@` reference menu. Menu is inert if empty. */
  mentionSources?: MentionSource[]
  /** Called when the user commits a mention (for optional backend resolution). */
  onMentionAdd?: (mention: ResolvedMention) => void
}

/** Message composer: a growing textarea inside a rounded card, with send/stop,
 *  an `@` reference menu, and image attachments (button, paste, drag-drop). */
export function ChatComposer({
  input,
  onInputChange,
  onKeyDown,
  onSend,
  onStop,
  isSending,
  disabled,
  placeholder = "Type a message…",
  attachments = [],
  onAttachmentsChange,
  mentionSources,
  onMentionAdd,
}: ChatComposerProps) {
  const canAttach = !!onAttachmentsChange && !disabled
  const hasContent = !!input.trim() || attachments.length > 0
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isDragging, setIsDragging] = useState(false)

  const mentions = useMentions({
    value: input,
    setValue: onInputChange,
    textareaRef,
    sources: mentionSources ?? NOOP_SOURCES,
    onResolve: onMentionAdd,
    enabled: (mentionSources?.length ?? 0) > 0,
  })

  async function addFiles(files: FileList | File[]) {
    if (!onAttachmentsChange) return
    const images = Array.from(files).filter((f) => f.type.startsWith("image/"))
    if (images.length === 0) return
    const staged = await Promise.all(images.map(fileToAttachment))
    onAttachmentsChange([...attachments, ...staged])
  }

  function removeAttachment(id: string) {
    onAttachmentsChange?.(attachments.filter((a) => a.id !== id))
  }

  function handlePaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (!canAttach) return
    const files = Array.from(e.clipboardData.files)
    if (files.some((f) => f.type.startsWith("image/"))) {
      e.preventDefault()
      void addFiles(files)
    }
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    if (!canAttach) return
    e.preventDefault()
    setIsDragging(false)
    if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files)
  }

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
          onDragOver={(e) => {
            if (!canAttach) return
            e.preventDefault()
            setIsDragging(true)
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          className={cn(
            "rounded-2xl border border-transparent bg-muted/50 px-2.5 py-2 shadow-sm",
            "transition-[border-color,box-shadow,background-color] duration-200",
            "focus-within:border-ring/30 focus-within:bg-background focus-within:shadow-md focus-within:ring-2 focus-within:ring-ring/15",
            isDragging && "border-ring/50 bg-background ring-2 ring-ring/20",
            disabled && "opacity-60"
          )}
        >
          {attachments.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-2 px-1">
              {attachments.map((a) => (
                <div
                  key={a.id}
                  className="group/att relative h-16 w-16 overflow-hidden rounded-lg border border-border/60 bg-background"
                >
                  <img
                    src={a.dataUrl}
                    alt={a.name}
                    className="h-full w-full object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.id)}
                    title="Remove attachment"
                    aria-label={`Remove ${a.name}`}
                    className="absolute right-0.5 top-0.5 rounded-full bg-background/80 p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/att:opacity-100"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-1.5">
            {canAttach && (
              <>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files) void addFiles(e.target.files)
                    e.target.value = ""
                  }}
                />
                <Button
                  onClick={() => fileInputRef.current?.click()}
                  variant="ghost"
                  size="icon"
                  title="Attach image"
                  aria-label="Attach image"
                  disabled={disabled}
                  className="h-8 w-8 flex-shrink-0 rounded-full text-muted-foreground hover:text-foreground"
                >
                  <Paperclip className="h-4 w-4" />
                </Button>
              </>
            )}
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
              onPaste={handlePaste}
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
    </div>
  )
}
