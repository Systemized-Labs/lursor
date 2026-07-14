import {
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react"
import { Clock, Paperclip, PaperPlaneTilt, Play, Square, X } from "@phosphor-icons/react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { ChatModeSelect } from "@/components/chat/ChatModeSelect"
import { MentionMenu } from "@/components/chat/mentions/MentionMenu"
import { useMentions } from "@/components/chat/mentions/use-mentions"
import type { MentionSource, ResolvedMention } from "@/components/chat/mentions/types"
import type { QueuedMessage } from "@/agui/useChat"
import type { PendingAttachment } from "@/agui/types"
import type { ChatMode } from "@/api/types"

const NOOP_SOURCES: MentionSource[] = []

/** Tallest the prompt grows before it starts scrolling internally (px). Big
 *  enough to read a pasted paragraph without the box eating the whole screen. */
const MAX_TEXTAREA_HEIGHT = 240

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
  /** Messages waiting to send after the current run settles (FIFO). */
  queuedMessages?: QueuedMessage[]
  /** Whether the queue is paused (won't auto-drain until resumed). */
  queuePaused?: boolean
  /** Drop a queued message. */
  onRemoveQueued?: (id: string) => void
  /** Edit a queued message's text in place. */
  onEditQueued?: (id: string, text: string) => void
  /** Send the queued messages now (resume a paused queue). */
  onResumeQueue?: () => void
  /** Current composer mode. Omit to hide the in-toolbar mode dropdown. */
  mode?: ChatMode
  /** Called when the user picks a different mode. */
  onModeChange?: (mode: ChatMode) => void
  /** Modes selectable right now; others render disabled. Defaults to all. */
  availableModes?: ChatMode[]
  /** Lock the dropdown to the current mode (e.g. an open goal/plan thread). */
  modeLocked?: boolean
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
  queuedMessages = [],
  queuePaused = false,
  onRemoveQueued,
  onEditQueued,
  onResumeQueue,
  mode,
  onModeChange,
  availableModes,
  modeLocked = false,
}: ChatComposerProps) {
  const canAttach = !!onAttachmentsChange && !disabled
  const hasContent = !!input.trim() || attachments.length > 0
  // Submitting now would queue rather than send: a run is streaming, or a
  // pending queue already exists that this message should join.
  const willQueue = isSending || queuedMessages.length > 0
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

  // Grow the prompt with its content (e.g. a pasted paragraph) up to a fixed
  // cap, then scroll internally. Runs whenever the value changes — including
  // programmatic changes like clearing after send or a mention insert.
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`
  }, [input])

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
            // One flat fill for the whole input (matches the app's other inputs
            // and the toolbar controls) — no focus-driven colour shift.
            "rounded-2xl border border-border/60 bg-muted/60 px-2.5 py-2",
            "transition-[border-color,box-shadow] duration-200",
            "focus-within:border-ring/40 focus-within:shadow-sm focus-within:ring-2 focus-within:ring-ring/10",
            isDragging && "border-ring/50 ring-2 ring-ring/20",
            disabled && "opacity-60"
          )}
        >
          {queuedMessages.length > 0 && (
            <div className="mb-1.5 flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2 px-1">
                <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  <Clock className="h-3 w-3 flex-shrink-0" />
                  <span>
                    {queuedMessages.length} queued ·{" "}
                    {queuePaused ? "paused" : "sends top to bottom"}
                  </span>
                </div>
                {queuePaused && onResumeQueue && (
                  <button
                    type="button"
                    onClick={onResumeQueue}
                    title="Send the queued messages now"
                    className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary hover:bg-primary/10"
                  >
                    <Play className="h-2.5 w-2.5" weight="fill" />
                    Send queue
                  </button>
                )}
              </div>
              {queuedMessages.map((q, i) => (
                <QueuedMessageRow
                  key={q.id}
                  index={i}
                  text={q.text}
                  attachmentCount={q.attachments.length}
                  onEdit={onEditQueued ? (text) => onEditQueued(q.id, text) : undefined}
                  onRemove={onRemoveQueued ? () => onRemoveQueued(q.id) : undefined}
                />
              ))}
            </div>
          )}
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
          {/* Prompt on its own line so it spans the card width. */}
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
            placeholder={willQueue ? "Add to queue…" : placeholder}
            disabled={disabled}
            rows={1}
            className={cn(
              "min-h-[34px] resize-none overflow-y-auto border-0 bg-transparent px-1 py-1.5 text-sm leading-relaxed shadow-none",
              "focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent disabled:bg-transparent dark:disabled:bg-transparent"
            )}
          />
          {/* Toolbar: mode + attach on the left, send/stop on the right. */}
          <div className="mt-1 flex items-center gap-1">
            {mode && onModeChange && (
              <ChatModeSelect
                mode={mode}
                onModeChange={onModeChange}
                availableModes={availableModes}
                locked={modeLocked}
                disabled={disabled}
              />
            )}
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
                  className="h-7 w-7 flex-shrink-0 rounded-full text-muted-foreground hover:text-foreground"
                >
                  <Paperclip className="h-4 w-4" />
                </Button>
              </>
            )}
            <div className="ml-auto flex flex-shrink-0 items-center gap-1.5">
              {isSending ? (
                <>
                  {hasContent && (
                    <Button
                      onClick={onSend}
                      size="icon"
                      title="Add to queue"
                      aria-label="Add to queue"
                      className="h-8 w-8 rounded-full"
                    >
                      <PaperPlaneTilt className="h-4 w-4" />
                    </Button>
                  )}
                  <Button
                    onClick={onStop}
                    variant="destructive"
                    size="icon"
                    title="Stop"
                    className="h-8 w-8 rounded-full"
                  >
                    <Square className="h-4 w-4" />
                  </Button>
                </>
              ) : (
                <Button
                  onClick={onSend}
                  disabled={disabled || !hasContent}
                  size="icon"
                  title={willQueue ? "Add to queue" : "Send"}
                  className={cn(
                    "h-8 w-8 rounded-full transition-transform duration-150",
                    hasContent && !disabled && "hover:scale-105 active:scale-95"
                  )}
                >
                  <PaperPlaneTilt className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

interface QueuedMessageRowProps {
  index: number
  text: string
  attachmentCount: number
  onEdit?: (text: string) => void
  onRemove?: () => void
}

/** One queued message: a numbered badge makes send order explicit (the top row
 *  is "Next"), and clicking the text edits it in place. */
function QueuedMessageRow({
  index,
  text,
  attachmentCount,
  onEdit,
  onRemove,
}: QueuedMessageRowProps) {
  const [draft, setDraft] = useState<string | null>(null)
  const isEditing = draft !== null
  const isNext = index === 0
  const label = text || (attachmentCount > 0 ? `${attachmentCount} attachment(s)` : "")

  function commit() {
    const next = draft?.trim()
    if (next && next !== text) onEdit?.(next)
    setDraft(null)
  }

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg px-1.5 py-1 text-xs",
        isNext
          ? "bg-primary/10 text-foreground ring-1 ring-primary/20"
          : "bg-muted/50 text-muted-foreground"
      )}
    >
      <span
        className={cn(
          "flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums",
          isNext
            ? "bg-primary text-primary-foreground"
            : "bg-muted-foreground/20 text-muted-foreground"
        )}
      >
        {index + 1}
      </span>
      {isEditing ? (
        <input
          autoFocus
          value={draft ?? ""}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              commit()
            }
            if (e.key === "Escape") {
              e.preventDefault()
              setDraft(null)
            }
          }}
          onBlur={commit}
          className="min-w-0 flex-1 border-b border-primary/40 bg-transparent py-0.5 text-foreground outline-none"
        />
      ) : (
        <button
          type="button"
          onClick={() => onEdit && setDraft(text)}
          title={onEdit ? "Click to edit" : undefined}
          className={cn(
            "min-w-0 flex-1 truncate text-left",
            onEdit && "cursor-text hover:text-foreground"
          )}
        >
          {label}
        </button>
      )}
      {isNext && !isEditing && (
        <span className="flex-shrink-0 text-[10px] uppercase tracking-wide text-primary">
          Next
        </span>
      )}
      {onRemove && !isEditing && (
        <button
          type="button"
          onClick={onRemove}
          title="Remove from queue"
          aria-label="Remove from queue"
          className="flex-shrink-0 text-muted-foreground hover:text-destructive"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  )
}
