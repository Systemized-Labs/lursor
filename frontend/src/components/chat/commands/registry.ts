import {
  ArrowsInLineVertical,
  ListChecks,
  NotePencil,
  Question,
  Target,
} from "@phosphor-icons/react"

import type { SlashCommand } from "./types"

/**
 * The built-in slash commands, in menu order. This is the single source of
 * truth for what commands exist (it replaced the old `chat-modes.ts` mode list).
 * Add a command by appending an entry — the parser, menu, and dispatch pick it
 * up automatically. A plain message (no command) runs the full agent.
 */
export const COMMANDS: SlashCommand[] = [
  {
    name: "ask",
    description: "Read-only — answer without editing",
    argumentHint: "<question>",
    Icon: Question,
    kind: "turn-intent",
    turnIntent: "ask",
    agentKey: "ask",
    agentScope: "turn",
  },
  {
    name: "plan",
    description: "Propose a plan without executing it",
    argumentHint: "<objective>",
    Icon: NotePencil,
    kind: "turn-intent",
    turnIntent: "plan",
    agentKey: "plan",
    // Plan mode is sticky: refinement turns (plain chat while parked) must reuse
    // the plan agent, so the switch is persisted to the thread.
    agentScope: "thread",
  },
  {
    name: "goal",
    description: "Work autonomously until the goal is met (one-off)",
    argumentHint: "<success condition>",
    Icon: Target,
    kind: "turn-intent",
    turnIntent: "goal",
    agentKey: "goal",
    agentScope: "turn",
  },
  {
    name: "compact",
    description: "Summarize the conversation to free up context",
    Icon: ArrowsInLineVertical,
    kind: "action",
    action: "compact",
  },
  {
    name: "clear",
    aliases: ["new"],
    description: "Start a new conversation",
    Icon: ListChecks,
    kind: "action",
    action: "new-conversation",
  },
]

/** Resolve a command by name or alias (case-insensitive). */
export function getCommand(name: string): SlashCommand | undefined {
  const key = name.toLowerCase()
  return COMMANDS.find(
    (c) => c.name === key || c.aliases?.includes(key)
  )
}

/** A parsed slash invocation: the matched command plus the remaining text. */
export interface ParsedCommand {
  command: SlashCommand
  /** The message body with the `/<name>` token removed — the arguments. */
  args: string
}

/**
 * Locate the first recognized `/command` token in the input, wherever it sits.
 * A command governs the whole turn, so only the first recognized token counts.
 * The `/` must sit at a word boundary (start of input or after whitespace) and
 * the name must be a letter followed by word chars/hyphens ending at whitespace
 * or end-of-input — matching {@link findActiveSlash} — which keeps paths
 * (`/Users`), dates (`7/17`) and fractions from being mistaken for commands.
 * Returns the token's character span and the resolved command, or `null`.
 */
export function findCommand(
  input: string
): { start: number; end: number; command: SlashCommand } | null {
  const re = /(^|\s)\/([a-zA-Z][\w-]*)(?=\s|$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(input)) !== null) {
    const command = getCommand(m[2])
    if (command) {
      const start = m.index + m[1].length
      return { start, end: start + 1 + m[2].length, command }
    }
  }
  return null
}

/**
 * Parse the governing `/command` out of the input, wherever it sits. Returns
 * `null` for a plain message (no recognized command), so the caller falls back
 * to a normal send. The command token is removed and the rest of the text —
 * anything before and after it — becomes the command's `args`.
 */
export function parseSlashCommand(input: string): ParsedCommand | null {
  const found = findCommand(input)
  if (!found) return null
  const before = input.slice(0, found.start).replace(/\s$/, "")
  const after = input.slice(found.end)
  return { command: found.command, args: (before + after).trim() }
}

/**
 * The character span of the governing `/command` token, for highlighting it in
 * the composer — exactly the token {@link parseSlashCommand} honors on send, so
 * the accent never implies an unknown slash is active. Returns `null` when the
 * input has no recognized command.
 */
export function commandRange(input: string): { start: number; end: number } | null {
  const found = findCommand(input)
  return found ? { start: found.start, end: found.end } : null
}

/**
 * Commands whose `/name` prefix is still being typed (no space yet), for the
 * autocomplete menu. `query` is the partial text after the slash.
 */
export function matchCommandPrefix(query: string): SlashCommand[] {
  const q = query.toLowerCase()
  if (!q) return COMMANDS
  return COMMANDS.filter(
    (c) =>
      c.name.startsWith(q) ||
      c.aliases?.some((a) => a.startsWith(q)) ||
      c.name.includes(q)
  )
}
