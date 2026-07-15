import { useMemo } from "react"
import { FileCode, Folder } from "@phosphor-icons/react"

import { filesApi } from "@/api/files"
import type { MentionItem, MentionSource } from "./types"

const SEARCH_LIMIT = 50

/** Mention sources for the workspace chat composer: a single `@files` category
 *  backed by a fuzzy search over the whole workspace tree. */
export function useWorkspaceChatMentionSources(
  workspaceId: string | undefined
): MentionSource[] {
  return useMemo<MentionSource[]>(() => {
    if (!workspaceId) return []
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
    ]
  }, [workspaceId])
}
