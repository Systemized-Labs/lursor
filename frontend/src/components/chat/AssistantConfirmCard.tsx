import { CheckCircle, Prohibit, Warning } from "@phosphor-icons/react"

import { useConfirmAction } from "@/api/assistant"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { AssistantConfirm } from "@/agui/types"

/**
 * The Assistant's stop-and-ask card for a destructive action.
 *
 * The run is genuinely blocked while this is on screen — the tool is awaiting
 * the answer (see `backend/app/assistant/confirm.py`), which is why the card
 * states the impact rather than just the verb: this is the last moment the
 * information is useful.
 *
 * A settled card stays in place rather than disappearing. The transcript should
 * still read correctly tomorrow, and "the Assistant asked and I said no" is part
 * of what happened.
 */
export function AssistantConfirmCard({ confirm }: { confirm: AssistantConfirm }) {
  const answer = useConfirmAction()
  const pending = confirm.status === "pending"

  return (
    <div
      className={cn(
        "mx-auto w-full max-w-3xl overflow-hidden rounded-xl border",
        pending ? "border-primary/40 bg-primary/5" : "border-border/60 bg-muted/30"
      )}
    >
      <div className="flex items-start gap-2.5 px-3 py-2.5">
        <Outcome status={confirm.status} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{confirm.summary}</p>
          {confirm.impact ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{confirm.impact}</p>
          ) : null}
          {!pending ? (
            <p className="mt-1 text-xs text-muted-foreground">{settledLabel(confirm)}</p>
          ) : null}
        </div>
      </div>

      {pending ? (
        <div className="flex items-center justify-end gap-2 border-t border-border/60 px-3 py-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={answer.isPending}
            onClick={() => answer.mutate({ token: confirm.token, approved: false })}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={answer.isPending}
            onClick={() => answer.mutate({ token: confirm.token, approved: true })}
          >
            Delete
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function Outcome({ status }: { status: AssistantConfirm["status"] }) {
  if (status === "approved") {
    return <CheckCircle weight="fill" className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
  }
  if (status === "pending") {
    return <Warning weight="fill" className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
  }
  return <Prohibit className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
}

function settledLabel(confirm: AssistantConfirm): string {
  switch (confirm.status) {
    case "approved":
      return "You approved this."
    case "denied":
      return "You cancelled this — nothing was changed."
    default:
      // A timeout is a denial, and saying so is the whole point: silence must
      // never read as consent.
      return "This expired without an answer — nothing was changed."
  }
}
