import type { ChatMessage } from "@/agui/types"

/** One file touched during an assistant turn, with rough line-change counts. */
export interface FileChangeSummary {
  /** Full path as reported by the tool call. */
  path: string
  /** Basename shown in the UI. */
  name: string
  additions: number
  deletions: number
}

// Tool names (from the pydantic-ai console toolset) that mutate files. The agent
// emits `write_file` (create/overwrite) and `edit_file` (string replacement);
// the others only appear under optional backend features but are cheap to cover.
const WRITE_TOOLS = new Set(["write_file"])
const EDIT_TOOLS = new Set(["edit_file", "hashline_edit"])
const DELETE_TOOLS = new Set(["delete_file"])

/** Line count of a text blob (empty string → 0). */
function lineCount(text: string): number {
  return text ? text.split("\n").length : 0
}

/** Basename of a path, tolerating trailing slashes and back-slashes. */
function basename(path: string): string {
  const clean = path.replace(/[\\/]+$/, "")
  const idx = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"))
  return idx >= 0 ? clean.slice(idx + 1) : clean
}

/** Parse a tool call's JSON argument string, or null if it isn't an object. */
function parseArgs(args: string): Record<string, unknown> | null {
  if (!args || !args.trim()) return null
  try {
    const obj: unknown = JSON.parse(args)
    return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** How many replacements an `edit_file` result reports (defaults to 1). */
function occurrences(result: string | undefined): number {
  const match = result?.match(/replaced (\d+) occurrence/)
  return match ? Math.max(1, Number.parseInt(match[1], 10)) : 1
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/**
 * Derive the set of files an assistant turn changed from its tool calls,
 * aggregating repeated edits to the same path. Line counts are approximated
 * from the tool arguments (there is no git numstat available): a write counts
 * its content lines as additions; an edit counts new/old string lines per
 * occurrence. Failed tool calls (error results) are ignored.
 */
export function deriveFileChanges(messages: ChatMessage[]): FileChangeSummary[] {
  const byPath = new Map<string, FileChangeSummary>()
  const order: string[] = []

  for (const message of messages) {
    for (const tc of message.toolCalls) {
      const isWrite = WRITE_TOOLS.has(tc.name)
      const isEdit = EDIT_TOOLS.has(tc.name)
      const isDelete = DELETE_TOOLS.has(tc.name)
      if (!isWrite && !isEdit && !isDelete) continue
      if (tc.result?.startsWith("Error")) continue

      const args = parseArgs(tc.args)
      const path = asString(args?.path)
      if (!path) continue

      let additions = 0
      let deletions = 0
      if (isWrite) {
        additions = lineCount(asString(args?.content))
      } else if (isEdit) {
        const times = occurrences(tc.result)
        additions =
          lineCount(asString(args?.new_string) || asString(args?.new_content)) * times
        deletions = lineCount(asString(args?.old_string)) * times
      }

      let entry = byPath.get(path)
      if (!entry) {
        entry = { path, name: basename(path), additions: 0, deletions: 0 }
        byPath.set(path, entry)
        order.push(path)
      }
      entry.additions += additions
      entry.deletions += deletions
    }
  }

  return order.map((path) => byPath.get(path) as FileChangeSummary)
}
