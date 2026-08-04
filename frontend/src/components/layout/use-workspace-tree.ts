import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type {
  SidebarLayout,
  Workspace,
  WorkspaceFolder,
} from "@/api/types"
import {
  useSaveSidebarLayout,
  useWorkspaceFolders,
} from "@/api/workspace-folders"

/** Which groups are shut, by id. A view preference, so it stays on the device. */
const COLLAPSED_KEY = "lursor:rail-folders-collapsed"
/**
 * The rail's old flat order, from before folders. Read once and deleted — see
 * {@link useWorkspaceTree}'s migration note.
 */
const LEGACY_ORDER_KEY = "lursor:workspace-order"

function loadCollapsed(): Set<string> {
  if (typeof window === "undefined") return new Set()
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((id): id is string => typeof id === "string"))
  } catch {
    return new Set()
  }
}

function loadLegacyOrder(): string[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(LEGACY_ORDER_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === "string")
  } catch {
    return []
  }
}

export interface RailWorkspace {
  workspace: Workspace
}

export type RailNode =
  | ({ kind: "workspace" } & RailWorkspace)
  | {
      kind: "folder"
      folder: WorkspaceFolder
      children: RailWorkspace[]
      collapsed: boolean
    }

/**
 * Where a dragged row is going: before the root row at `index`, or into a
 * group at `index` among its members. Folders only ever land at the root —
 * one level deep is what lets the root sequence interleave the two lists.
 */
export type RailDrop =
  | { kind: "root"; index: number }
  | { kind: "folder"; folderId: string; index: number }

/** The thing being dragged, which is either kind of row. */
export interface RailDragged {
  kind: "workspace" | "folder"
  id: string
}

export interface WorkspaceTree {
  /** The rail's rows, top to bottom. */
  nodes: RailNode[]
  /** Every workspace in tree order — what ⌘1…⌘9 address. */
  ordered: Workspace[]
  folders: WorkspaceFolder[]
  isCollapsed: (folderId: string) => boolean
  toggleFolder: (folderId: string) => void
  /** Apply a drop, optimistically and then on the server. */
  move: (dragged: RailDragged, to: RailDrop) => void
  /** File a workspace into a group (or out of one, with `null`) by name. */
  moveToFolder: (workspaceId: string, folderId: string | null) => void
}

/** A root row before positions are handed out: a group, or a loose workspace. */
type RootEntry =
  | { kind: "folder"; id: string; folder: WorkspaceFolder }
  | { kind: "workspace"; id: string; workspace: Workspace }

/**
 * The rail's arrangement: which group each workspace is in, and the order of
 * everything.
 *
 * Server-held, unlike the flat order this replaces. Tile order was a device
 * preference because it *was* only a preference — but a group is a thing you
 * made and named, and one that existed on the laptop and not on the phone (the
 * app is reachable over the LAN) would be a filing system that forgets. So
 * membership and order both live in `workspace_folders` / `workspaces.position`,
 * and the one genuinely per-device bit — which groups you have shut — stays in
 * localStorage.
 *
 * Ordering is deliberately not by recency. A rail you switch through dozens of
 * times a day is navigated by position: you reach for "the second tile", and ⌘2
 * has to mean the same workspace every time. Recency would move your targets
 * around precisely because you use them. It lives in `use-workspace-visits`,
 * where it drives only the MRU switch.
 */
export function useWorkspaceTree(workspaces: Workspace[]): WorkspaceTree {
  const foldersQuery = useWorkspaceFolders()
  const saveLayout = useSaveSidebarLayout()

  const folders = useMemo(
    () =>
      [...(foldersQuery.data ?? [])].sort(
        (a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at)
      ),
    [foldersQuery.data]
  )

  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed)

  // Skip the first run, which would write back exactly what `loadCollapsed` read.
  const loaded = useRef(false)
  useEffect(() => {
    if (!loaded.current) {
      loaded.current = true
      return
    }
    try {
      window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]))
    } catch {
      // Ignore quota / disabled-storage errors — this is a view preference.
    }
  }, [collapsed])

  // ── The tree ──────────────────────────────────────────────────────────────
  // Positions come from the server and can be stale, duplicated or missing
  // (a workspace created while another client was dragging), so creation order
  // breaks every tie: the arrangement is always *some* total order, never a
  // list whose rows swap places between renders.
  const bySlot = useMemo(() => {
    const byPosition = (
      a: { position: number; created_at: string },
      b: { position: number; created_at: string }
    ) => a.position - b.position || a.created_at.localeCompare(b.created_at)

    const known = new Set(folders.map((f) => f.id))
    // A workspace whose folder was deleted out from under this client still has
    // to be reachable, so it reads as loose rather than vanishing with the group.
    const filed = (ws: Workspace) =>
      ws.folder_id && known.has(ws.folder_id) ? ws.folder_id : null

    const children = new Map<string, Workspace[]>()
    const loose: Workspace[] = []
    for (const ws of workspaces) {
      const folderId = filed(ws)
      if (folderId === null) loose.push(ws)
      else {
        const group = children.get(folderId)
        if (group) group.push(ws)
        else children.set(folderId, [ws])
      }
    }
    for (const group of children.values()) group.sort(byPosition)
    loose.sort(byPosition)

    const root: RootEntry[] = [
      ...folders.map((folder) => ({
        kind: "folder" as const,
        id: folder.id,
        folder,
      })),
      ...loose.map((workspace) => ({
        kind: "workspace" as const,
        id: workspace.id,
        workspace,
      })),
    ].sort((a, b) =>
      byPosition(
        a.kind === "folder" ? a.folder : a.workspace,
        b.kind === "folder" ? b.folder : b.workspace
      )
    )

    return { root, children }
  }, [workspaces, folders])

  // `ordered` is the ⌘1–⌘9 sequence: counted over the whole tree rather than over
  // what is on screen, so shutting a group doesn't renumber the projects below it
  // — ⌘3 has to mean the same project whether or not the group above it is open.
  // Rows used to carry their own `slot` number to print as a hover badge; the
  // badge is gone and the position was always just this walk's index.
  const { nodes, ordered } = useMemo(() => {
    const out: RailNode[] = []
    const flat: Workspace[] = []
    for (const entry of bySlot.root) {
      if (entry.kind === "workspace") {
        flat.push(entry.workspace)
        out.push({ kind: "workspace", workspace: entry.workspace })
        continue
      }
      const members = (bySlot.children.get(entry.id) ?? []).map((workspace) => {
        flat.push(workspace)
        return { workspace }
      })
      out.push({
        kind: "folder",
        folder: entry.folder,
        children: members,
        collapsed: collapsed.has(entry.id),
      })
    }
    return { nodes: out, ordered: flat }
  }, [bySlot, collapsed])

  // ── Moving rows ───────────────────────────────────────────────────────────
  const move = useCallback(
    (dragged: RailDragged, to: RailDrop) => {
      // Work on plain id lists: a move is two edits (pull the row out, put it
      // back), and doing that on ids keeps the two structures — the root
      // sequence and each group's members — independent of render order.
      const root = bySlot.root.map((entry) => ({ kind: entry.kind, id: entry.id }))
      const children = new Map(
        [...bySlot.children].map(([id, group]) => [id, group.map((ws) => ws.id)])
      )
      for (const folder of folders) {
        if (!children.has(folder.id)) children.set(folder.id, [])
      }

      // Pull the row out of wherever it currently is, remembering the list it
      // came from: a drop index is measured against the list as it looks *now*,
      // so a row moving *within* one list leaves every later slot one lower,
      // while a row arriving from elsewhere shifts nothing.
      let from: { list: "root" | "folder"; folderId?: string; index: number } | null =
        null
      const rootIndex = root.findIndex((entry) => entry.id === dragged.id)
      if (rootIndex >= 0) {
        root.splice(rootIndex, 1)
        from = { list: "root", index: rootIndex }
      } else {
        for (const [folderId, group] of children) {
          const index = group.indexOf(dragged.id)
          if (index >= 0) {
            group.splice(index, 1)
            from = { list: "folder", folderId, index }
            break
          }
        }
      }

      const insertAt = (
        length: number,
        index: number,
        sameList: boolean
      ) => {
        const shifted = sameList && from !== null && from.index < index
        return Math.max(0, Math.min(length, shifted ? index - 1 : index))
      }

      if (dragged.kind === "folder") {
        // Groups don't nest, so a folder dropped inside one lands beside it.
        const index =
          to.kind === "root"
            ? to.index
            : Math.max(
                0,
                root.findIndex((entry) => entry.id === to.folderId)
              )
        root.splice(insertAt(root.length, index, from?.list === "root"), 0, {
          kind: "folder",
          id: dragged.id,
        })
      } else if (to.kind === "folder") {
        const group = children.get(to.folderId)
        if (!group) return
        const sameGroup = from?.list === "folder" && from.folderId === to.folderId
        group.splice(insertAt(group.length, to.index, sameGroup), 0, dragged.id)
      } else {
        root.splice(insertAt(root.length, to.index, from?.list === "root"), 0, {
          kind: "workspace",
          id: dragged.id,
        })
      }

      // Renumber everything rather than sending a delta: one drop can move a row
      // between groups *and* reorder both, and a complete picture is idempotent.
      const layout: SidebarLayout = { folders: [], workspaces: [] }
      root.forEach((entry, position) => {
        if (entry.kind === "folder") {
          layout.folders.push({ id: entry.id, position })
        } else {
          layout.workspaces.push({
            id: entry.id,
            folder_id: null,
            position,
          })
        }
      })
      for (const [folderId, group] of children) {
        group.forEach((id, position) => {
          layout.workspaces.push({ id, folder_id: folderId, position })
        })
      }

      saveLayout.mutate(layout)
    },
    [bySlot, folders, saveLayout]
  )

  const moveToFolder = useCallback(
    (workspaceId: string, folderId: string | null) => {
      if (folderId === null) {
        move({ kind: "workspace", id: workspaceId }, {
          kind: "root",
          index: bySlot.root.length,
        })
        return
      }
      const size = bySlot.children.get(folderId)?.length ?? 0
      move({ kind: "workspace", id: workspaceId }, {
        kind: "folder",
        folderId,
        index: size,
      })
    },
    [bySlot, move]
  )

  // ── One-time migration off the old flat order ─────────────────────────────
  // Before folders the rail's order lived only in localStorage. The server's
  // backfill put every workspace in *creation* order, so without this an
  // upgrade would silently reshuffle a rail somebody had arranged by hand.
  // Replayed once and the key deleted, so it can't fight a later drag.
  const migrated = useRef(false)
  useEffect(() => {
    if (migrated.current || workspaces.length === 0) return
    // Only meaningful while everything is still loose: once groups exist the
    // root sequence interleaves them, and a flat list of workspace ids says
    // nothing about where the groups went.
    if (!foldersQuery.isSuccess || folders.length > 0) return

    const legacy = loadLegacyOrder()
    migrated.current = true
    window.localStorage.removeItem(LEGACY_ORDER_KEY)
    if (legacy.length === 0) return

    const known = new Map(workspaces.map((ws) => [ws.id, ws]))
    const ids = legacy.filter((id) => known.has(id))
    for (const ws of workspaces) if (!ids.includes(ws.id)) ids.push(ws.id)
    // Nothing to say if the server already agrees.
    const current = [...workspaces]
      .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at))
      .map((ws) => ws.id)
    if (current.join() === ids.join()) return

    saveLayout.mutate({
      folders: [],
      workspaces: ids.map((id, position) => ({
        id,
        folder_id: null,
        position,
      })),
    })
  }, [workspaces, folders, foldersQuery.isSuccess, saveLayout])

  const isCollapsed = useCallback(
    (folderId: string) => collapsed.has(folderId),
    [collapsed]
  )

  const toggleFolder = useCallback((folderId: string) => {
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return next
    })
  }, [])

  return useMemo(
    () => ({
      nodes,
      ordered,
      folders,
      isCollapsed,
      toggleFolder,
      move,
      moveToFolder,
    }),
    [nodes, ordered, folders, isCollapsed, toggleFolder, move, moveToFolder]
  )
}
