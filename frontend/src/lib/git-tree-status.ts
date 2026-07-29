import type { FileGitStatus, GitStatus } from "@/api/git"

/**
 * What a file-tree row is decorated with: a file's own git state, a folder's
 * rollup of the states beneath it, or `ignored`.
 */
export type GitDecoration = FileGitStatus | "ignored"

export interface GitStatusIndex {
  /** The decoration for a tree row, or null when git has nothing to say. */
  forPath: (path: string, isDir: boolean) => GitDecoration | null
}

/** A repo-less workspace (the skills catalog) and the pre-fetch state both use it. */
const CLEAN: GitStatusIndex = { forPath: () => null }

/**
 * Which state a folder takes when it holds several.
 *
 * A conflict is the one thing you must not miss, and an edit to an existing file
 * outranks a new one: a folder of new files is new, but a folder holding one
 * changed file among new ones is somewhere you have work in progress. Untracked
 * and added tie because they carry the same colour — for a folder, which draws a
 * dot rather than a letter, they are the same answer.
 */
const SEVERITY: Record<FileGitStatus, number> = {
  conflicted: 4,
  modified: 3,
  deleted: 2,
  added: 1,
  untracked: 1,
}

/** The parent directory of a workspace-relative path ("" at the top level). */
function parentOf(path: string): string {
  const i = path.lastIndexOf("/")
  return i === -1 ? "" : path.slice(0, i)
}

/**
 * Index a workspace's git status for row-by-row lookup by the file tree.
 *
 * Changes roll *up*: every ancestor of a changed path carries the most severe
 * state beneath it, so a folder shows that something inside it changed while it is
 * still collapsed — which is the whole point of the decoration.
 *
 * Ignored paths arrive as a mix of files and wholly-ignored directories (the
 * server collapses those, so `node_modules` is one entry, not forty thousand).
 * Both are matched by walking a row's ancestors, so the cost per row is its depth
 * rather than the length of the ignore list.
 */
export function buildGitStatusIndex(status?: GitStatus): GitStatusIndex {
  if (!status?.is_repo) return CLEAN

  const files = new Map<string, FileGitStatus>()
  const folders = new Map<string, FileGitStatus>()
  for (const file of status.files) {
    files.set(file.path, file.status)
    for (let dir = parentOf(file.path); dir; dir = parentOf(dir)) {
      const current = folders.get(dir)
      if (current === undefined || SEVERITY[file.status] > SEVERITY[current]) {
        folders.set(dir, file.status)
      }
    }
  }

  const ignoredFiles = new Set<string>()
  const ignoredDirs = new Set<string>()
  for (const path of status.ignored) {
    if (path.endsWith("/")) ignoredDirs.add(path.slice(0, -1))
    else ignoredFiles.add(path)
  }

  const isIgnored = (path: string, isDir: boolean): boolean => {
    if (isDir ? ignoredDirs.has(path) : ignoredFiles.has(path)) return true
    for (let dir = parentOf(path); dir; dir = parentOf(dir)) {
      if (ignoredDirs.has(dir)) return true
    }
    return false
  }

  return {
    forPath: (path, isDir) => {
      // A state wins over the dim: a tracked file inside an ignored path can still
      // be modified, and a folder holding changes is not a folder to fade out.
      const own = isDir ? folders.get(path) : files.get(path)
      if (own) return own
      return isIgnored(path, isDir) ? "ignored" : null
    },
  }
}
