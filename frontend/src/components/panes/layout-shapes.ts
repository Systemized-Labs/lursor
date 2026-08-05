import type {
  Orientation,
  SerializedDockview,
  SerializedGridObject,
} from "dockview-react"

import { PANE_KINDS, type PaneParams } from "@/components/panes/pane-kinds"

/**
 * What a serialized dockview layout is, in one place: the node constructors, the
 * orientation constants, the per-panel state, and the readers that walk a tree.
 *
 * Split out of `use-pane-layout` so the templates share one definition rather than
 * each having their own. **This is the only module that narrows a serialized tree** —
 * anything that needs to know what a node holds asks {@link asLeaf} or one of the
 * walkers below rather than casting `data` itself.
 *
 * **Type-only imports from dockview, deliberately.** This module is reached from
 * the shell on every route, and `Orientation` is a *runtime* enum — importing it
 * as a value pulls all 76KB of dockview into the entry chunk even with the pane
 * host lazy-loaded. See {@link HORIZONTAL}.
 */

/**
 * `Orientation.HORIZONTAL` / `VERTICAL` without importing the enum.
 *
 * It is a string enum, so each member's value is literally its name. The double
 * cast is the price of keeping the import type-only; it is checked by every use
 * below, which is typed against the real `SerializedDockview`.
 */
export const HORIZONTAL = "HORIZONTAL" as unknown as Orientation
export const VERTICAL = "VERTICAL" as unknown as Orientation

/**
 * The per-group shape in a serialized layout. v7 does not re-export
 * `GroupPanelViewState` from its public entry, so it is recovered from the type
 * that *is* public — two lines, and it keeps an `any` out of the one place that
 * must not have one (the plan's §3.7).
 */
type GroupState =
  SerializedDockview["grid"]["root"] extends SerializedGridObject<infer T>
    ? T
    : never

export type SerializedNode = SerializedGridObject<GroupState>

/** One group holding `views`, tabbed, with the first as the active tab. */
export const leaf = (
  id: string,
  views: string[],
  size?: number
): SerializedNode => ({
  type: "leaf",
  data: { id, views, activeView: views[0] },
  size,
})

export const branch = (
  children: SerializedNode[],
  size?: number
): SerializedNode => ({ type: "branch", data: children, size })

// ── reading a serialized tree ───────────────────────────────────────────────
//
// `SerializedGridObject<T>` types `data` as `T | SerializedGridObject<T>[]` without
// discriminating on `type`, so every reader used to re-assert the shape by hand:
// eighteen `as` casts across three files, four walkers in the layouts dialog alone,
// and three separate answers to "what are this tree's leaves". The narrowing happens
// here now, twice, and nowhere else.

/**
 * A zone, as a serialized layout records it: `id`, `views`, `activeView`.
 *
 * **Derived from dockview's own type rather than re-declared as those three fields**,
 * which matters more than it looks. A grid zone's state can also carry `locked`,
 * `hideHeader`, `headerPosition`, `constraints` and `tabGroups`, and a hand-written
 * three-field interface would let a caller build a "leaf" that quietly dropped every
 * one of them on the way through {@link mapLeaves}. Spelling it as `GroupState` means
 * a leaf can only be rebuilt by spreading the one it came from.
 */
export type LeafData = GroupState

/**
 * A node's leaf data, or null if it is a branch.
 *
 * One of the two casts in this file, and the reason the other sixteen are gone.
 * Narrowing on `type` is sound — dockview writes `data` as the group state exactly
 * when `type` is `"leaf"` — it is just not something the published type expresses.
 */
export function asLeaf(node: SerializedNode): LeafData | null {
  return node.type === "leaf" ? (node.data as LeafData) : null
}

/** A branch's children, or nothing for a leaf. The other cast. */
export function children(node: SerializedNode): SerializedNode[] {
  return node.type === "leaf" ? [] : (node.data as SerializedNode[])
}

/**
 * Every zone in a tree, left to right, depth first.
 *
 * The one traversal the readers below are all phrased in terms of. Its order is
 * load-bearing and shared with {@link mapLeaves}: `reshape` reads the zones to build
 * a positional roster list and then writes them back in the same sweep, so the two
 * walks have to agree about which zone is third.
 */
export function leaves(node: SerializedNode): LeafData[] {
  const leaf = asLeaf(node)
  if (leaf) return [leaf]
  return children(node).flatMap(leaves)
}

/** How many zones a tree has. */
export function countLeaves(node: SerializedNode): number {
  return leaves(node).length
}

/** Each zone's view list, in {@link leaves} order. */
export function leafViews(node: SerializedNode): string[][] {
  return leaves(node).map((leaf) => leaf.views)
}

/** Each zone's id, in {@link leaves} order. */
export function leafIds(node: SerializedNode): string[] {
  return leaves(node).map((leaf) => leaf.id)
}

/**
 * The tree with `f` applied to every zone, structure untouched.
 *
 * Every node is rebuilt rather than mutated, because a serialized layout handed to
 * `fromJSON` may be the live `toJSON()` — the arrangement callers are deriving the
 * next one *from* — and editing that in place would corrupt the thing they are
 * comparing against.
 *
 * `f` is called in {@link leaves} order, which is what lets a caller deal panes out
 * of a positional list as it goes (see `reshape`).
 */
export function mapLeaves(
  node: SerializedNode,
  f: (leaf: LeafData) => LeafData
): SerializedNode {
  const leaf = asLeaf(node)
  if (leaf) return { ...node, data: f(leaf) }
  return { ...node, data: children(node).map((child) => mapLeaves(child, f)) }
}

/** A panel's serialized state, including the renderer its kind requires. */
export function panelState(id: string, params: PaneParams) {
  const def = PANE_KINDS[params.kind]
  return {
    id,
    contentComponent: params.kind,
    tabComponent: "pane",
    title: def.title,
    renderer: def.renderer,
    params,
  }
}
