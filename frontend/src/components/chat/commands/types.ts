import type { Icon } from "@phosphor-icons/react"

import type { DefaultAgentsSettings, ThreadMode, TurnIntent } from "@/api/types"

/**
 * What a slash command *does*, as a closed set the dispatch switches on. The
 * UI shell (parser, menu, dispatch, pill) is generic over these three kinds, so
 * adding a command is a single {@link SlashCommand} entry in the registry — no
 * new branches in the composer or page. See `registry.ts`.
 */
export type CommandKind =
  | "turn-intent" // per-message modifier, e.g. /ask (stateless)
  | "thread-mode" // sticky mode owning the thread, e.g. /plan, /goal
  | "action" // fire-and-forget local action, e.g. /clear (no agent turn)

/** A named local action a command can trigger (kind === "action"). */
export type CommandAction = "new-conversation"

/**
 * A slash command, expressed as data. This descriptor is the single source of
 * truth: the menu renders it, the parser matches it, and the dispatch acts on
 * its `kind`. Future commands (`/review`, `/test`, …) are added by appending to
 * `COMMANDS` — nothing else changes.
 */
export interface SlashCommand {
  /** Invoked as `/<name>`. Lowercase, no spaces. */
  name: string
  /** Extra spellings that resolve to this command (e.g. `/new` → clear). */
  aliases?: string[]
  /** One-line description shown in the menu. */
  description: string
  /** Argument shape shown after the name in the menu (e.g. `<condition>`). */
  argumentHint?: string
  Icon: Icon
  kind: CommandKind
  /** Per-command default agent, keyed into {@link DefaultAgentsSettings}. When
   *  set, using the command switches to (and reassigns the thread to) that
   *  agent. */
  agentKey?: keyof DefaultAgentsSettings
  /** kind === "turn-intent": the per-turn intent to send. */
  turnIntent?: TurnIntent
  /** kind === "thread-mode": the sticky mode to enter. */
  enterMode?: ThreadMode
  /** kind === "action": the local action to run. */
  action?: CommandAction
}
