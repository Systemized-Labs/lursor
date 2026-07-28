/**
 * Where a skill's files live, as a workspace + workspace-relative path.
 *
 * A skill row in the manager and a folder in a workspace tree are the same
 * thing seen from two directions. This is the bridge: given a {@link Skill},
 * work out which workspace can edit it and where inside that workspace it sits,
 * so any surface can hand the user a real editor (plus an agent and a terminal)
 * instead of a form.
 */

import type { Skill, Workspace } from "@/api/types"
import { requestOpenFile } from "@/lib/open-file"

/** What a skill stored in Lursor's own catalog is called, next to the `~/.claude`
 *  and `~/.hermes` of the linked ones. Matches `OWN_SOURCE_LABEL` in the files API,
 *  so the Skill Studio's file tree and every skill list say the same word. */
export const OWN_SOURCE_LABEL = "Lursor"

/**
 * Whose files these really are, in a few characters.
 *
 * Not the same question as which *layer* a skill won at: a personal skill linked
 * into the catalog resolves at the catalog's precedence but still lives in
 * `~/.claude`, and editing it still changes what Claude Code reads. That is the
 * fact worth surfacing wherever a skill is listed — the reach is already shown
 * elsewhere, and it is only the source that a name alone can never tell you.
 *
 * A repo skill keeps its bare `.claude` / `.agents`, which reads distinctly from
 * the `~/`-prefixed personal roots without needing to spell out the workspace.
 */
export function skillSourceLabel(skill: Skill): string {
  if (skill.link_target) return skill.link_label || "Linked"
  if (skill.origin === "managed") return OWN_SOURCE_LABEL
  return skill.root_label || (skill.origin === "local" ? ".agents" : "Other tool")
}

export interface SkillLocation {
  workspaceId: string
  /** Workspace-relative path to the skill's SKILL.md. */
  path: string
  /** Tab label — the slug, since every skill's file is called SKILL.md. */
  name: string
}

/**
 * Resolve a skill to an openable location, or null when nothing can open it
 * (a repo-local skill with no workspace, a skill in a personal directory that
 * belongs to no workspace at all, or the Skill Studio row not loaded yet — it is
 * registered at startup, so that window is the first paint only).
 */
export function skillLocation(
  skill: Skill,
  workspaces: Workspace[]
): SkillLocation | null {
  // Skills in a personal root (~/.claude/skills) sit outside every workspace, so
  // no file tree reaches them. The editor dialog still opens them by id — or link
  // one into the catalog, after which it takes the `managed` branch below and the
  // Studio tree reaches the original through the symlink.
  if (skill.origin === "external") return null
  // Repo-local skills live under one of their own workspace's skill roots, which
  // that workspace's own chat already edits — send them home rather than to the
  // studio, which cannot see them. The root is whichever one they were found in,
  // not always .agents/skills.
  if (skill.origin === "local") {
    return skill.workspace_id
      ? {
          workspaceId: skill.workspace_id,
          path: `${skill.root || ".agents/skills"}/${skill.slug}/SKILL.md`,
          name: `${skill.slug}/SKILL.md`,
        }
      : null
  }
  const studio = workspaces.find((ws) => ws.is_system)
  return studio
    ? {
        workspaceId: studio.id,
        path: `${skill.slug}/SKILL.md`,
        name: `${skill.slug}/SKILL.md`,
      }
    : null
}

/**
 * The skill folder as a path on disk, or null when it can't be resolved.
 *
 * A linked entry reports where its files *really* are, not the link that stands in
 * for them in the catalog — that path is the answer to "what would I edit", and
 * pasting it into a terminal should land on the file the other tool reads.
 * `external` roots are already absolute. The other two are relative to a workspace
 * directory: the repo that owns a `local` skill, and the catalog workspace
 * (`is_system`) for a `managed` one — so the location is read off the workspace
 * list rather than assuming where the catalog lives.
 */
export function skillFolder(skill: Skill, workspaces: Workspace[]): string | null {
  if (skill.link_target) return skill.link_target
  if (skill.origin === "external") return `${skill.root}/${skill.slug}`
  if (skill.origin === "local") {
    const workspace = workspaces.find((ws) => ws.id === skill.workspace_id)
    if (!workspace) return null
    return `${workspace.path}/${skill.root || ".agents/skills"}/${skill.slug}`
  }
  const catalog = workspaces.find((ws) => ws.is_system)
  return catalog ? `${catalog.path}/${skill.slug}` : null
}

/**
 * Park an "open this skill" request and return the route to navigate to. The
 * app shell reveals the dock and mounts a file tab; the editor consumes the
 * request once mounted (see {@link requestOpenFile}).
 *
 * Usage: `navigate(revealSkill(location))`.
 */
export function revealSkill(location: SkillLocation): string {
  requestOpenFile(location)
  return `/workspaces/${location.workspaceId}/chat`
}
