import { ListChecks, PencilSimple, Question } from "@phosphor-icons/react"

import type { ChatMode } from "@/api/types"

/** Order + presentation for the Ask / Edit / Goal chat modes. Shared by the
 *  composer dropdown and the per-mode default-model settings section. */
export const MODE_META: Record<
  ChatMode,
  { label: string; hint: string; Icon: typeof Question }
> = {
  ask: { label: "Ask", hint: "Read-only — answers without editing", Icon: Question },
  edit: { label: "Edit", hint: "Chat and make changes", Icon: PencilSimple },
  goal: { label: "Goal", hint: "Draft a plan, then approve to run", Icon: ListChecks },
}

export const MODE_ORDER: ChatMode[] = ["ask", "edit", "goal"]
