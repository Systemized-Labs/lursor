import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select"
import type { ChatMode } from "@/api/types"
import { MODE_META, MODE_ORDER } from "./chat-modes"

export interface ChatModeSelectProps {
  mode: ChatMode
  onModeChange: (mode: ChatMode) => void
  /** Modes selectable right now; others render disabled. Defaults to all. */
  availableModes?: ChatMode[]
  /** Lock the dropdown to the current mode (e.g. an open goal/plan thread). */
  locked?: boolean
  disabled?: boolean
}

/** The Ask / Edit / Goal mode dropdown shown below the chat input. */
export function ChatModeSelect({
  mode,
  onModeChange,
  availableModes,
  locked = false,
  disabled = false,
}: ChatModeSelectProps) {
  const { label, Icon } = MODE_META[mode]
  return (
    <Select
      value={mode}
      onValueChange={(v) => onModeChange(v as ChatMode)}
      disabled={disabled || locked}
    >
      <SelectTrigger
        aria-label="Chat mode"
        className="h-7 w-auto gap-1 whitespace-nowrap rounded-md border-0 bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none hover:bg-accent hover:text-foreground focus:ring-0 data-[state=open]:bg-accent data-[state=open]:text-foreground [&>svg:last-child]:h-3.5 [&>svg:last-child]:w-3.5 [&>svg:last-child]:opacity-60"
      >
        {/* Compact trigger label (the items carry the full description). */}
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span>{label}</span>
      </SelectTrigger>
      <SelectContent align="start">
        {MODE_ORDER.map((m) => {
          const meta = MODE_META[m]
          const enabled = availableModes ? availableModes.includes(m) : true
          const ItemIcon = meta.Icon
          return (
            <SelectItem key={m} value={m} disabled={!enabled}>
              <span className="flex items-center gap-2">
                <ItemIcon className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="flex flex-col">
                  <span className="text-foreground">{meta.label}</span>
                  <span className="text-[11px] text-muted-foreground">{meta.hint}</span>
                </span>
              </span>
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )
}
