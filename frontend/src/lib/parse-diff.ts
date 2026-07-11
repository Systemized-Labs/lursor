/**
 * Minimal unified-diff parser for the Changes panel.
 *
 * Turns a `git diff` patch into hunks of typed lines carrying their old/new
 * line numbers, plus a `gapBefore` count — the number of unmodified lines git
 * skipped since the previous hunk. The panel renders that gap as a collapsed
 * "N unmodified lines" row, matching a Cursor/GitHub-style diff view.
 */

/** A single rendered row within a hunk. */
export interface DiffLine {
  type: "context" | "add" | "del"
  /** Line number on the old side (null for added lines). */
  oldNo: number | null
  /** Line number on the new side (null for removed lines). */
  newNo: number | null
  /** Line text without its leading +/-/space marker. */
  content: string
}

/** A contiguous change region, with the count of lines skipped before it. */
export interface DiffHunk {
  gapBefore: number
  lines: DiffLine[]
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * Parse a unified diff into hunks. File-level headers (`diff --git`, `index`,
 * `---`/`+++`, mode lines) are ignored — only the `@@` hunks and their body
 * lines are returned. Returns an empty array for an empty or headers-only patch.
 */
export function parseDiff(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = []
  if (!patch) return hunks

  let current: DiffHunk | null = null
  let oldNo = 0
  let newNo = 0
  // The new-side line just past the previous hunk, used to size the next gap.
  let prevNewEnd = 1

  for (const line of patch.split("\n")) {
    const header = HUNK_HEADER.exec(line)
    if (header) {
      const newStart = Number.parseInt(header[3], 10)
      current = { gapBefore: Math.max(0, newStart - prevNewEnd), lines: [] }
      hunks.push(current)
      oldNo = Number.parseInt(header[1], 10)
      newNo = newStart
      continue
    }
    if (!current) continue // still in the file header preamble

    const marker = line[0]
    if (marker === "+") {
      current.lines.push({ type: "add", oldNo: null, newNo, content: line.slice(1) })
      newNo += 1
    } else if (marker === "-") {
      current.lines.push({ type: "del", oldNo, newNo: null, content: line.slice(1) })
      oldNo += 1
    } else if (marker === " ") {
      current.lines.push({ type: "context", oldNo, newNo, content: line.slice(1) })
      oldNo += 1
      newNo += 1
    }
    // Ignore "\ No newline at end of file" and any stray blank trailing line.
    prevNewEnd = newNo
  }

  return hunks
}
