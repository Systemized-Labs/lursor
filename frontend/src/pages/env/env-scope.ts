import type { EnvVar, ResolvedEnvEntry } from "@/api/types"

/**
 * Which rail section a variable belongs to — its *broadest* reach.
 *
 * Unlike the skills rail, which sections by where files live precisely so a row
 * never moves while you edit it, a variable has nothing but reach: it is a row in
 * a table plus its assignments. So the sections are the assignment, and re-pointing
 * a variable does move its row. That is survivable here because the selection is
 * held by id in the URL and the detail pane is keyed by id — the pane you are
 * editing stays mounted and stays selected, the row just relocates under it, which
 * is the clearest possible confirmation that the change landed.
 */
export type EnvScope = "global" | "workspaces" | "skills" | "unassigned"

export const ENV_SCOPES: { key: EnvScope; title: string; hint: string }[] = [
  {
    key: "global",
    title: "Everywhere",
    hint: "Injected into every run, in every workspace. The lowest layer — anything more specific overrides it.",
  },
  {
    key: "workspaces",
    title: "Per workspace",
    hint: "Injected only into runs started in the workspaces it is assigned to. Overrides a global value of the same name.",
  },
  {
    key: "skills",
    title: "With a skill",
    hint: "Injected whenever one of these skills is in scope, and into that skill's own scripts. The highest layer — it wins over everything.",
  },
  {
    key: "unassigned",
    title: "Not applied",
    hint: "Stored, but attached to nothing, so no run receives it. Give it a reach to make it live.",
  },
]

export function envScope(envVar: EnvVar): EnvScope {
  if (envVar.is_global) return "global"
  if (envVar.workspace_ids.length > 0) return "workspaces"
  if (envVar.skill_ids.length > 0) return "skills"
  return "unassigned"
}

/** Where this applies, in the width a rail row can spare. */
export function reachLabel(
  envVar: EnvVar,
  workspaceNames: Map<string, string>,
  skillNames: Map<string, string>
): string {
  if (envVar.is_global) return "Everywhere"
  const [firstWorkspace, ...restWorkspaces] = envVar.workspace_ids
  if (firstWorkspace) {
    return restWorkspaces.length === 0
      ? (workspaceNames.get(firstWorkspace) ?? "1 workspace")
      : `${envVar.workspace_ids.length} workspaces`
  }
  const [firstSkill, ...restSkills] = envVar.skill_ids
  if (firstSkill) {
    return restSkills.length === 0
      ? (skillNames.get(firstSkill) ?? "1 skill")
      : `${envVar.skill_ids.length} skills`
  }
  return "Nowhere"
}

/** The same thing as a sentence, for the detail pane. */
export function reachSummary(
  envVar: EnvVar,
  workspaceNames: Map<string, string>,
  skillNames: Map<string, string>
): string {
  const parts: string[] = []
  if (envVar.is_global) parts.push("every run")
  else if (envVar.workspace_ids.length > 0) {
    const names = envVar.workspace_ids.map((id) => workspaceNames.get(id) ?? "an unknown workspace")
    parts.push(`runs in ${names.join(", ")}`)
  }
  if (envVar.skill_ids.length > 0) {
    const names = envVar.skill_ids.map((id) => skillNames.get(id) ?? "an unknown skill")
    parts.push(`runs where ${names.join(", ")} ${envVar.skill_ids.length === 1 ? "is" : "are"} in scope`)
  }
  if (parts.length === 0) return "Nothing receives this yet."
  return `Injected into ${parts.join(", and ")}.`
}

/**
 * The layer strings this variable would occupy in one workspace, in the same
 * vocabulary the resolver reports: `global`, `workspace`, `skill:<slug>`.
 *
 * Deliberately *candidate* layers, not effective ones. Whether a skill is really
 * in scope for a workspace depends on disk state, root precedence and slug
 * collisions that only the backend can settle (`app/skills/resolve.py`), so the
 * caller intersects this with what {@link envVarsApi.resolved} actually reported
 * rather than trying to re-derive it here.
 */
export function candidateLayers(
  envVar: EnvVar,
  workspaceId: string,
  skillSlugs: Map<string, string>
): string[] {
  const layers: string[] = []
  if (envVar.is_global) layers.push("global")
  if (envVar.workspace_ids.includes(workspaceId)) layers.push("workspace")
  for (const id of envVar.skill_ids) {
    const slug = skillSlugs.get(id)
    if (slug) layers.push(`skill:${slug}`)
  }
  return layers
}

/** How one variable fares in a workspace, once the resolver has ruled. */
export interface Standing {
  /** The layer this variable won or lost at. */
  layer: string
  /** True when this variable's value is the one a run there receives. */
  winning: boolean
  /** Set when it loses: the layer that beat it. */
  beatenBy?: string
}

/**
 * Whether a run in the previewed workspace gets *this* variable's value.
 *
 * Two variables may share a key at different layers, which is legal and is the
 * whole point of the precedence chain — so being in scope is not the same as
 * being the value that lands.
 */
export function standingIn(
  envVar: EnvVar,
  entry: ResolvedEnvEntry | undefined,
  workspaceId: string,
  skillSlugs: Map<string, string>
): Standing | null {
  if (!entry) return null
  const layers = candidateLayers(envVar, workspaceId, skillSlugs)
  if (layers.length === 0) return null
  if (layers.includes(entry.source)) return { layer: entry.source, winning: true }
  // `overridden` is only populated when more than one layer set the key, so a
  // variable that shares a key with the winner is in scope but shadowed.
  const lost = layers.find((layer) => entry.overridden.includes(layer))
  if (!lost) return null
  return { layer: lost, winning: false, beatenBy: entry.source }
}

/** `skill:wiki-cli` → `wiki-cli`, anything else unchanged. */
export function layerLabel(layer: string): string {
  return layer.startsWith("skill:") ? layer.slice("skill:".length) : layer
}
