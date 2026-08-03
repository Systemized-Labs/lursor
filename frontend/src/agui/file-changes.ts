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

// Tool names (from the pydantic-ai console toolset) that mutate files. We run the
// `hashline` edit format, so the edit tool is `hashline_edit`; `edit_file` is the
// `str_replace` format's tool and only appears if an agent's `extra_config` flips
// `edit_format`. `delete_file` is not registered by any toolset we build — kept so
// a file removed by some future backend feature still shows up in the list.
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

/**
 * Line counts for a `hashline_edit`, read out of its result summary.
 *
 * The arguments cannot supply them: `hashline_edit` sends `new_content` but no
 * `old_string`, so counting from args alone reported `-0` on every edit and
 * `+0 -0` on a pure deletion. The summary carries both numbers — one of
 * `Replaced N line(s) with M line(s) at line X`, `Replaced N line(s) at line X`
 * (an equal-length replacement), `Deleted N line(s) at line X`, or
 * `Inserted N line(s) after line X` (`pydantic_ai_backends/hashline.py`).
 */
function hashlineCounts(result: string | undefined): { additions: number; deletions: number } {
  const replacedWith = result?.match(/Replaced (\d+) line\(s\) with (\d+) line\(s\)/)
  if (replacedWith) {
    return {
      deletions: Number.parseInt(replacedWith[1], 10),
      additions: Number.parseInt(replacedWith[2], 10),
    }
  }
  const replaced = result?.match(/Replaced (\d+) line\(s\)/)
  if (replaced) {
    const count = Number.parseInt(replaced[1], 10)
    return { additions: count, deletions: count }
  }
  const deleted = result?.match(/Deleted (\d+) line\(s\)/)
  if (deleted) return { additions: 0, deletions: Number.parseInt(deleted[1], 10) }
  const inserted = result?.match(/Inserted (\d+) line\(s\)/)
  if (inserted) return { additions: Number.parseInt(inserted[1], 10), deletions: 0 }
  return { additions: 0, deletions: 0 }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/**
 * Derive the set of files an assistant turn changed from its tool calls,
 * aggregating repeated edits to the same path. Line counts are approximated
 * (there is no git numstat available): a write counts its content lines as
 * additions, a `hashline_edit` reads both numbers out of its result summary, and
 * an `edit_file` counts new/old string lines per occurrence. Failed tool calls
 * (error results) are ignored.
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
      } else if (tc.name === "hashline_edit") {
        ;({ additions, deletions } = hashlineCounts(tc.result))
      } else if (isEdit) {
        const times = occurrences(tc.result)
        additions = lineCount(asString(args?.new_string)) * times
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
