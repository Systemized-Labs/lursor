/**
 * Shared helper for recognizing "plan" docs — the goal agent's `PLAN-<slug>.md`
 * and its kin (`PLAN.md`, `PROJECT_PLAN.md`, `GOAL_PLAN.md`, …).
 *
 * Lives in `lib/` (not `file-viewer.tsx`) so lightweight surfaces — e.g. the
 * mobile plan view and the app shell's open-file router — can classify a path
 * without eagerly pulling in the Monaco-heavy editor module.
 */

const MARKDOWN_EXTS = new Set(["md", "mdx", "markdown"])

function extOf(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ""
}

/**
 * A Markdown file whose basename contains a whole "plan" token — matched on a
 * token boundary so `planner.md` and `explanation.md` don't qualify.
 */
export function isPlanFile(name: string): boolean {
  const ext = extOf(name)
  if (!MARKDOWN_EXTS.has(ext)) return false
  const base = name.slice(0, name.length - ext.length - 1).toLowerCase()
  return base.split(/[^a-z0-9]+/).includes("plan")
}

/**
 * The plan's first Markdown H1 (`# Title`) text, or `""`. Used as the objective
 * shown on the execute divider and the goal header. Mirrors the backend's
 * `extract_plan_title`.
 */
export function planTitle(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const m = /^#\s+(.*\S)\s*$/.exec(line)
    if (m) return m[1].trim()
  }
  return ""
}

/**
 * The body of the plan's `## Success Criteria` section (heading at any level),
 * up to the next heading of the same-or-higher level, or `""`. Mirrors the
 * backend's `extract_success_criteria`.
 */
export function planSuccessCriteria(text: string): string {
  const lines = text.split(/\r?\n/)
  let start = -1
  let level = 0
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i])
    if (m && m[2].trim().toLowerCase() === "success criteria") {
      start = i + 1
      level = m[1].length
      break
    }
  }
  if (start < 0) return ""
  const body: string[] = []
  for (let i = start; i < lines.length; i++) {
    const m = /^(#{1,6})\s+/.exec(lines[i])
    if (m && m[1].length <= level) break
    body.push(lines[i])
  }
  return body.join("\n").trim()
}
