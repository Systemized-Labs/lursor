import type {
  Orientation,
  SerializedDockview,
  SerializedGridObject,
} from "dockview-react"

import { PANE_KINDS, type PaneParams } from "@/components/panes/pane-kinds"

/**
 * The bits every module that *authors* a dockview layout needs: the node
 * constructors, the orientation constants, and the per-panel state.
 *
 * Split out of `use-pane-layout` so the templates share one definition of what a
 * serialized layout looks like rather than each having their own.
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
