import { useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

interface RenameDialogProps {
  title: string
  /** Seeds the field each time the dialog opens. */
  initialValue: string
  open: boolean
  pending: boolean
  onCancel: () => void
  onSave: (value: string) => void
}

/**
 * A rename prompt that owns its text field.
 *
 * The draft used to be `useState` in the hook above, which runs inside
 * `AppSidebar` — so every keystroke re-rendered the rail, the panel, every
 * workspace section and every conversation row. Radix unmounts dialog content
 * when closed, so the field is naturally fresh on each open and the value never
 * has to leave this component.
 */
export function RenameDialog({
  title,
  initialValue,
  open,
  pending,
  onCancel,
  onSave,
}: RenameDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <RenameField
          initialValue={initialValue}
          pending={pending}
          onCancel={onCancel}
          onSave={onSave}
        />
      </DialogContent>
    </Dialog>
  )
}

function RenameField({
  initialValue,
  pending,
  onCancel,
  onSave,
}: Omit<RenameDialogProps, "title" | "open">) {
  const [value, setValue] = useState(initialValue)
  return (
    <>
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            onSave(value)
          }
        }}
        autoFocus
      />
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={() => onSave(value)} disabled={pending || !value.trim()}>
          Save
        </Button>
      </DialogFooter>
    </>
  )
}
