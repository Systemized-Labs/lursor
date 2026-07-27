import { useMemo } from "react"
import { FileCode, Folder, ListChecks, Sparkle } from "@phosphor-icons/react"

import { filesApi } from "@/api/files"
import { useSkills } from "@/api/skills"
import type { Skill } from "@/api/types"
import type { MentionItem, MentionSource } from "./types"

const SEARCH_LIMIT = 50

/** Workspace-relative folder holding plan docs. Kept out of `@files` search
 *  (see backend `_IGNORED_DIRS`), so plans get their own mention category. */
const PLAN_DIR = ".agents/plan"

/** Mention sources for the workspace chat composer:
 *  - `@files` — fuzzy search over the whole workspace tree (lazy).
 *  - `@plan` — the plan docs under `.agents/plan/` (hidden from `@files`).
 *  - `@skill` — the skills in scope for this workspace (pre-loaded, root-searchable).
 *    Referencing a skill force-loads its full body into that turn server-side.
 */
export function useWorkspaceChatMentionSources(
  workspaceId: string | undefined
): MentionSource[] {
  // Exactly what the agent sees at build time: the backend resolves the three
  // layers (global assignment → assigned to this workspace → the repo's own
  // .agents/skills) and returns one winner per slug. Asking for the resolved set
  // rather than merging here means a parked or elsewhere-assigned skill is never
  // offered — referencing it would be a no-op server-side. Small list, so
  // pre-load it and filter locally rather than hitting the server per keystroke.
  const skillsQuery = useSkills(
    workspaceId
      ? { assignment: "workspace", workspace_id: workspaceId }
      : undefined
  )

  return useMemo<MentionSource[]>(() => {
    if (!workspaceId) return []

    const skillItems = [...(skillsQuery.data ?? [])]
      .sort((a: Skill, b: Skill) => a.name.localeCompare(b.name))
      .map<MentionItem>((s) => ({
        id: s.id,
        label: s.name,
        slug: s.slug,
        sublabel: s.description || undefined,
      }))

    return [
      {
        key: "files",
        label: "Files",
        icon: FileCode,
        // Fuzzy-search the whole tree server-side. `query` is the text after
        // `@/files/` (or the bare `@query` at the root); an empty query yields a
        // default listing. Flat results — files and folders both resolve as a
        // reference (no hierarchical drilling).
        browse: async (query: string) => {
          const entries = await filesApi.search(workspaceId, query, SEARCH_LIMIT)
          return entries.map<MentionItem>((e) => {
            const slash = e.path.lastIndexOf("/")
            return {
              id: e.path,
              label: e.name,
              slug: e.path,
              icon: e.is_dir ? Folder : undefined,
              // Show the containing directory to disambiguate same-named entries.
              sublabel: slash === -1 ? undefined : e.path.slice(0, slash),
            }
          })
        },
      },
      {
        key: "plan",
        label: "Plans",
        icon: ListChecks,
        // Plan docs live under `.agents/plan/`, which `@files` search skips — so
        // list that folder directly (it's exposed to `/files/list`) and filter to
        // Markdown plans. `query` narrows by filename; the slug is the basename,
        // rebuilt into the full path on send (see `expandMentionTokens`).
        browse: async (query: string) => {
          const entries = await filesApi.list(workspaceId, PLAN_DIR)
          const q = query.toLowerCase()
          return entries
            .filter((e) => !e.is_dir && e.name.toLowerCase().endsWith(".md"))
            .filter((e) => !q || e.name.toLowerCase().includes(q))
            .map<MentionItem>((e) => ({ id: e.path, label: e.name, slug: e.name }))
        },
      },
      {
        key: "skill",
        label: "Skills",
        icon: Sparkle,
        items: skillItems,
      },
    ]
  }, [workspaceId, skillsQuery.data])
}
