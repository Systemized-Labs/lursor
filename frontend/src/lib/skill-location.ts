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
  // no file tree reaches them. The editor dialog still opens them by id.
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
 * `external` roots are already absolute. The other two are relative to a
 * workspace directory: the repo that owns a `local` skill, and the catalog
 * workspace (`is_system`) for a `managed` one — so the location is read off the
 * workspace list rather than assuming where the catalog lives.
 */
export function skillFolder(skill: Skill, workspaces: Workspace[]): string | null {
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
