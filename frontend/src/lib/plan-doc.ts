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
