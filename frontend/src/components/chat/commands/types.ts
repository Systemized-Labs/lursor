import type { Icon } from "@phosphor-icons/react"

import type { DefaultAgentsSettings, TurnIntent } from "@/api/types"

/**
 * What a slash command *does*, as a closed set the dispatch switches on. The
 * UI shell (parser, menu, dispatch) is generic over these kinds, so adding a
 * command is a single {@link SlashCommand} entry in the registry — no new
 * branches in the composer or page. See `registry.ts`.
 */
export type CommandKind =
  | "turn-intent" // per-message intent, e.g. /ask, /goal, /plan (stateless)
  | "action" // fire-and-forget local action, e.g. /clear (no agent turn)

/** A named local action a command can trigger (kind === "action"). */
export type CommandAction = "new-conversation"

/** The active `/…` command token under the caret. */
export interface ActiveSlash {
  /** Index of the `/` in the text. */
  start: number
  /** Caret index (token end, exclusive). */
  end: number
  /** Raw text between `/` and the caret — the partial command name. */
  query: string
}

/**
 * Locate the `/…` command token immediately preceding `caret`, if any. Modelled
 * on `findActiveMention`: the `/` must sit at a word boundary (start of input or
 * after whitespace) with no whitespace between it and the caret, so the menu can
 * trigger anywhere in the input — not only when the whole value is `/command`.
 * The token after the slash must look like a command name (a letter followed by
 * word chars/hyphens), which keeps paths (`/Users`), dates (`7/17`, where the
 * `/` isn't at a boundary), and fractions from opening the menu.
 */
export function findActiveSlash(text: string, caret: number): ActiveSlash | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === "/") {
      const prev = i > 0 ? text[i - 1] : ""
      if (i !== 0 && !/\s/.test(prev)) return null
      const query = text.slice(i + 1, caret)
      // Empty (bare `/`) or a well-formed partial command name only.
      if (query !== "" && !/^[a-zA-Z][\w-]*$/.test(query)) return null
      return { start: i, end: caret, query }
    }
    if (/\s/.test(ch)) return null
  }
  return null
}

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
  /** kind === "action": the local action to run. */
  action?: CommandAction
}
