import { Check } from "@phosphor-icons/react"

import { cn } from "@/lib/utils"
import { ScrollArea } from "@/components/ui/scroll-area"

export interface MultiSelectOption {
  value: string
  label: string
  description?: string
}

interface MultiSelectProps {
  options: MultiSelectOption[]
  selected: string[]
  onChange: (selected: string[]) => void
  emptyText?: string
}

export function MultiSelect({
  options,
  selected,
  onChange,
  emptyText = "No options available.",
}: MultiSelectProps) {
  function toggle(value: string) {
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value))
    } else {
      onChange([...selected, value])
    }
  }

  if (options.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center rounded-md border border-dashed border-border/70 bg-muted/20 p-4 text-center text-sm text-muted-foreground">
        {emptyText}
      </div>
    )
  }

  return (
    <ScrollArea className="h-40 rounded-md border">
      <div className="p-1">
        {options.map((option) => {
          const isSelected = selected.includes(option.value)
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => toggle(option.value)}
              className={cn(
                "flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground",
                isSelected && "bg-accent/50"
              )}
            >
              <span
                className={cn(
                  "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-primary",
                  isSelected
                    ? "bg-primary text-primary-foreground"
                    : "opacity-50"
                )}
              >
                {isSelected ? <Check className="h-3 w-3" /> : null}
              </span>
              <span className="min-w-0">
                <span className="block truncate font-medium text-foreground">
                  {option.label}
                </span>
                {option.description ? (
                  <span className="block truncate text-xs text-muted-foreground">
                    {option.description}
                  </span>
                ) : null}
              </span>
            </button>
          )
        })}
      </div>
    </ScrollArea>
  )
}
