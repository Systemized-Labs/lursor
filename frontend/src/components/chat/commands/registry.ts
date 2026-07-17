import {
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
  },
  {
    name: "plan",
    description: "Propose a plan, then approve to run it",
    argumentHint: "<objective>",
    Icon: NotePencil,
    kind: "thread-mode",
    enterMode: "plan",
    agentKey: "plan",
  },
  {
    name: "goal",
    description: "Work autonomously until the goal is met",
    argumentHint: "<success condition>",
    Icon: Target,
    kind: "thread-mode",
    enterMode: "goal",
    agentKey: "goal",
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
  /** Everything after `/<name> ` — the message body / arguments. */
  args: string
}

/**
 * Parse a leading `/command` off the input. Returns `null` when the text isn't a
 * recognized command (a plain message, or `/unknown`), so the caller falls back
 * to a normal send. Matches `/name` followed by a space or end-of-input.
 */
export function parseSlashCommand(input: string): ParsedCommand | null {
  const m = input.match(/^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/)
  if (!m) return null
  const command = getCommand(m[1])
  if (!command) return null
  return { command, args: (m[2] ?? "").trim() }
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
