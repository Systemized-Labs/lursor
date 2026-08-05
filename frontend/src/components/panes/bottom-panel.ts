import type {
  DockviewApi,
  DockviewGroupPanel,
  DockviewPanelRenderer,
  IDockviewPanel,
  SerializedDockview,
} from "dockview-react"

import {
  HORIZONTAL,
  VERTICAL,
  asLeaf,
  branch,
  children,
  leaf,
  leaves,
  type SerializedNode,
} from "@/components/panes/layout-shapes"
import type { PaneParams } from "@/components/panes/pane-kinds"

/**
 * The bottom panel: the grid's bottom row, and the one zone that can be collapsed onto its
 * tab strip.
 *
 * **There is no drawer.** Three designs came before this one and each was a version of the
 * same mistake — a second kind of thing that behaved like a zone but was not one.
 *
 * 1. Dockview's *edge group*: a citizen of the shell around the grid, so its panes were
 *    destroyed by `fromJSON`, invisible to `onDidLayoutChange`, subtracted from every
 *    template's zone count, and unreachable by a drag.
 * 2. An ordinary group with a reserved id: which let the layout hold a bottom panel *and*
 *    a drawer, because a drop on the lower edge of the zone above inserted another
 *    full-width row that answered to none of the drawer's controls.
 * 3. That id plus a drop overlay of our own, claiming drops dockview would have resolved
 *    itself: two ways to put a pane along the bottom, one of them drawing a band that said
 *    "drop here for the drawer" over a layout perfectly capable of accepting the drop.
 *
 * What is left is the whole feature: **dockview arranges the zones, and whichever zone
 * ends up as the bottom row can be collapsed.** Dragging a pane below another one is an
 * ordinary dockview split; if it lands across the bottom of the window then it *is* the
 * bottom panel. No band, no claimed drops, no reserved id, nothing to keep in step.
 * {@link bottomRowId} is the entire definition, read off the grid tree.
 *
 * The two things dockview will not keep for us:
 *
 * - **Collapse.** A collapsed row is pinned with `setConstraints({ min: max: 36 })`.
 *   Measured: a grid group pinned that way holds 36px across window resizes and sash
 *   drags, and releases cleanly — it is the same lock `EdgeGroupView` applies to itself
 *   one level out, and splitview clamps every redistribution to `[min, max]`. Dockview's
 *   own `collapse()` is a documented no-op off the edges; the *capability* is not.
 * - **State.** Constraints are not serialized, so the collapsed flag and the height to
 *   come back to are ours ({@link BottomPanelState}) and ours to persist (see
 *   `use-pane-layout`). They belong to the *layout*, not to a group — the bottom row
 *   changes identity underneath them, and {@link syncBottomPanel} is what moves them.
 *
 * **Type-only imports from dockview**, like `layout-shapes`: this module is reached from
 * `use-pane-layout`, which the shell imports on every route, so a value import here would
 * pull dockview into the entry chunk past the lazy pane host.
 */

/** Marks the bottom row for the stylesheet; `pane-theme.css` reads both. */
const PANEL_CLASS = "lursor-bottom-panel"
const COLLAPSED_CLASS = "lursor-bottom-collapsed"

/**
 * The height of a collapsed bottom panel: its tab strip and nothing else.
 *
 * Matches `--dv-tabs-and-actions-container-height` in `pane-theme.css`. A constant rather
 * than a measurement — a themed strip that changed height would need both updated, which
 * is cheaper than a ResizeObserver for a value with one definition.
 */
const STRIP_HEIGHT = 36

/**
 * The floor the panel comes back to when it is let go: dockview's own default for a group
 * (`MINIMUM_DOCKVIEW_GROUP_PANEL_HEIGHT`). Releasing to zero instead would let a sash drag
 * it down to a sliver that is neither open nor collapsed.
 */
const MIN_OPEN_HEIGHT = 100

/** How tall it expands the first time, before it has a height to remember. */
const INITIAL_HEIGHT = 260

/** The share of the window a template gives the bottom row when it draws one. */
const BOTTOM_SHARE = 30

// ── state ───────────────────────────────────────────────────────────────────
//
// Held per dockview instance rather than per workspace: the pane host mounts once and
// loads each workspace's layout into it, and `use-pane-layout` is what scopes the
// persisted copy.

export interface BottomPanelState {
  /** Collapsed onto its strip — pinned to {@link STRIP_HEIGHT}. */
  collapsed: boolean
  /** The height to come back to, tracked while it is open. */
  height: number
}

const states = new WeakMap<DockviewApi, BottomPanelState>()

/** This layout's bottom-panel state, defaulted on first ask. */
function panelState(api: DockviewApi): BottomPanelState {
  const existing = states.get(api)
  if (existing) return existing
  const fresh: BottomPanelState = { collapsed: false, height: INITIAL_HEIGHT }
  states.set(api, fresh)
  return fresh
}

/** The state to persist, for `use-pane-layout`. */
export function readPanelState(api: DockviewApi): BottomPanelState {
  return { ...panelState(api) }
}

/**
 * Adopt a persisted state and put it back on the layout.
 *
 * Called after `fromJSON`, which is where the pin and the classes went: the group in the
 * restored layout is a new object, and all it inherited from the saved tree is a row
 * height of 36 with nothing holding it there.
 */
export function restorePanelState(
  api: DockviewApi,
  stored: Partial<BottomPanelState> | null
): void {
  const next = panelState(api)
  next.collapsed = stored?.collapsed ?? false
  next.height =
    typeof stored?.height === "number" && stored.height > MIN_OPEN_HEIGHT
      ? stored.height
      : INITIAL_HEIGHT
  syncBottomPanel(api)
}

// ── which zone is the bottom row ────────────────────────────────────────────

/**
 * The id of the grid's bottom row, or null when it has not got one.
 *
 * **The whole definition.** Read off the serialized tree rather than measured, so it is
 * exact and available before the DOM has laid anything out — a `fromJSON` restores a
 * collapsed panel, and the pin has to go back on before the first paint, not after it.
 *
 * Dockview alternates orientation per level, so a *vertical* level's children are rows and a
 * horizontal one's are columns. The walk descends while a level has nothing to say — a level
 * with one child is not a split at all — and stops at the first real one:
 *
 * - rows, two or more: the last is the bottom band. It qualifies if it is a single zone; a
 *   branch there is two groups sharing the bottom of the window, and neither of them is
 *   "the bottom row".
 * - columns: nothing at this level spans the width, so nothing below is a bottom row —
 *   a zone stacked under one column is that column's business.
 *
 * **Both shapes have to be recognised**, which is why this is a walk and not a look at the
 * root. Dockview writes two stacked rows as `V [top bottom]` when it orthogonalizes at the
 * root (`addGroup({ direction: 'below' })`) and as `H [[top bottom]]` when it nests one
 * level down (a drop on the lower edge of the only zone). They are the same picture, and a
 * definition that only knew the first left a bottom panel with no caret on it — measured.
 */
export function bottomRowId(grid: SerializedDockview["grid"]): string | null {
  const flip = (axis: typeof VERTICAL) =>
    axis === VERTICAL ? HORIZONTAL : VERTICAL

  const walk = (node: SerializedNode, axis: typeof VERTICAL): string | null => {
    const kids = children(node)
    if (kids.length === 0) return null // a leaf: no split, so no row below anything
    if (kids.length === 1) return walk(kids[0], flip(axis))
    if (axis !== VERTICAL) return null // columns
    const id = asLeaf(kids[kids.length - 1])?.id
    if (!id) return null
    // A row that holds nothing is not a row above. `withBottomRow` no longer builds the
    // shape that used to strand one, but a layout from an older build may still carry it,
    // and a panel under an empty band should read as the plain zone it has become.
    const occupied = kids
      .slice(0, -1)
      .some((row) => leaves(row).some((zone) => zone.views.length > 0))
    return occupied ? id : null
  }

  return walk(grid.root, grid.orientation)
}

/** The id of the live layout's bottom row. */
export function bottomPanelId(api: DockviewApi): string | null {
  return bottomRowId(api.toJSON().grid)
}

/** The zone that is currently the bottom panel, if the layout has a bottom row. */
export function bottomPanelGroup(
  api: DockviewApi
): DockviewGroupPanel | undefined {
  const id = bottomPanelId(api)
  return id ? api.groups.find((group) => group.api.id === id) : undefined
}

/** Whether the layout has a bottom row at all. */
export function hasBottomPanel(api: DockviewApi): boolean {
  return bottomPanelGroup(api) !== undefined
}

/**
 * The panes in the zones a template arranges — everything but the bottom row's.
 *
 * The bottom row's are held back for the reason they always were: dealing them into columns
 * is what would pull a running shell out of the panel the user put it in. Nothing is held
 * back when there is no bottom row (see {@link bottomRowId}).
 */
export function gridPanes(api: DockviewApi): IDockviewPanel[] {
  const panel = bottomPanelGroup(api)
  return api.panels.filter((pane) => pane.api.group !== panel)
}

/** The ids in the bottom row, in tab order. */
export function bottomPaneIds(api: DockviewApi): string[] {
  return bottomPanelGroup(api)?.panels.map((pane) => pane.api.id) ?? []
}

// ── collapse, expand ────────────────────────────────────────────────────────

export function isBottomCollapsed(api: DockviewApi): boolean {
  return panelState(api).collapsed
}

/** Collapse the bottom panel onto its strip, keeping everything in it running. */
export function collapseBottomPanel(api: DockviewApi): void {
  const state = panelState(api)
  if (state.collapsed) return
  const group = bottomPanelGroup(api)
  if (group) state.height = Math.round(group.api.height)
  state.collapsed = true
  syncBottomPanel(api)
}

/**
 * Expand it, to the height it was collapsed at.
 *
 * A no-op when it is already open, so callers do not have to ask first — and the reason
 * every path that reveals a pane down there goes through it: activating a tab in a
 * collapsed panel would make it the active tab of a 36px strip, and the app would consider
 * the request served while the user saw nothing change.
 */
export function expandBottomPanel(api: DockviewApi): void {
  const state = panelState(api)
  if (!state.collapsed) return
  state.collapsed = false
  syncBottomPanel(api)
}

/**
 * Put this layout's state onto whichever zone is the bottom row, and take it off every zone
 * that is not.
 *
 * Every group is visited, not just the one: the bottom row changes identity — a `fromJSON`
 * rebuilds all of them, closing a pane promotes the row above, dragging the bottom row into
 * a column makes it an ordinary zone — and a 36px pin left behind on a zone that is no
 * longer at the bottom is a column nobody can resize. The state belongs to the layout; this
 * is the only thing that knows which group is currently wearing it.
 *
 * Idempotent, and wired to `onDidLayoutChange`. While the panel is open this is also what
 * tracks the height a sash drag left it at, so {@link collapseBottomPanel} has something to
 * come back to.
 */
export function syncBottomPanel(api: DockviewApi): void {
  const id = bottomPanelId(api)
  const state = panelState(api)

  for (const group of api.groups) {
    const isPanel = group.api.id === id
    group.element.classList.toggle(PANEL_CLASS, isPanel)
    group.element.classList.toggle(COLLAPSED_CLASS, isPanel && state.collapsed)

    const pinned = group.maximumHeight <= STRIP_HEIGHT
    if (isPanel && state.collapsed) {
      if (!pinned) {
        group.api.setConstraints({
          minimumHeight: STRIP_HEIGHT,
          maximumHeight: STRIP_HEIGHT,
        })
        group.api.setSize({ height: STRIP_HEIGHT })
      }
      continue
    }
    if (pinned) {
      group.api.setConstraints({
        minimumHeight: MIN_OPEN_HEIGHT,
        maximumHeight: Number.MAX_SAFE_INTEGER,
      })
      group.api.setSize({ height: state.height })
      continue
    }
    // Open, unpinned and at the bottom: whatever height it is at now is the height to come
    // back to.
    if (isPanel) {
      const live = Math.round(group.api.height)
      if (live > MIN_OPEN_HEIGHT) state.height = live
    }
  }
}

// ── putting panes in it ─────────────────────────────────────────────────────

/**
 * A pane to open, before anything has said where it goes.
 *
 * Spelled out rather than borrowed from `addPanel`: its options type is a union
 * discriminated on *placement*, and spreading one member of it into another is the one
 * thing that union will not let you do.
 */
export interface BottomPane {
  id: string
  component: string
  tabComponent?: string
  title?: string
  renderer?: DockviewPanelRenderer
  params?: PaneParams
}

/**
 * Add a pane to the bottom row, making the row — and expanding it — as needed.
 *
 * The one placement request that is not "here": a template whose schematic draws a band
 * along the bottom needs a shell in it, and the zone the user happens to be in is not where
 * that goes. Everything else — a zone's `+`, an empty-state card, a route, a drag — names a
 * zone, or lets dockview decide.
 */
export function openInBottomPanel(api: DockviewApi, pane: BottomPane): void {
  const existing = bottomPanelGroup(api)
  const group =
    existing ??
    // A `direction` with no reference is dockview's own absolute placement — the same call
    // its outer-edge drops use — so the row lands across the full bottom of the grid
    // however the zones above it are arranged. No id is asked for: being last under a
    // vertical root is what makes it the bottom row.
    api.addGroup({ direction: "below" })
  api.addPanel({
    ...pane,
    position: { referenceGroup: group, direction: "within" },
  })
  const state = panelState(api)
  state.collapsed = false
  if (!existing) group.api.setSize({ height: state.height })
  syncBottomPanel(api)
}

/**
 * Focus a pane, expanding the bottom panel first if that is where it lives.
 *
 * Any path that reveals a pane on the user's behalf — a route, a link, "open this file
 * here" — can land on one inside a collapsed panel, and has to open it.
 */
export function revealPanel(api: DockviewApi, pane: IDockviewPanel): void {
  if (pane.api.group === bottomPanelGroup(api)) expandBottomPanel(api)
  pane.api.setActive()
}

// ── layouts with a bottom row in them ───────────────────────────────────────

/**
 * The id a built layout gives its bottom row.
 *
 * Descriptive, not load-bearing: nothing looks the panel up by name — {@link bottomRowId}
 * reads the shape — but a zone in a serialized tree needs *some* id, and one that says
 * where it sits beats a counter when you are reading a stored layout by hand.
 */
const BOTTOM_ROW_ID = "bottom"

/**
 * A grid with `views` as its bottom row.
 *
 * How a template draws the band. The root flips to vertical and the arrangement so far
 * becomes its first child, which is what makes the new row sit under *all* of it rather
 * than inside one column — dockview alternates orientation per level, so the columns
 * nested one deeper still lay out side by side. Which is also exactly the shape
 * {@link bottomRowId} recognises, from the other end.
 */
export function withBottomRow(
  grid: SerializedDockview["grid"],
  views: string[]
): SerializedDockview["grid"] {
  if (views.length === 0) return grid
  // A branch with one child is a level dockview never builds and will not clean up. Wrap
  // one and the arrangement is `[[main] bottom]`; close the pane in `main` and dockview
  // removes the leaf but leaves the branch — `[[] bottom]`, which is 70% of the window held
  // by nothing, above a panel pinned to the other 30%. Measured, and the reason the only
  // child is hoisted to be the row itself: what this builds is then the same shape dockview
  // produces for `addGroup({ direction: 'below' })`, which it *does* prune.
  const rows = children(grid.root)
  const top = rows.length === 1 ? rows[0] : grid.root
  return {
    ...grid,
    orientation: VERTICAL,
    root: branch([
      { ...top, size: 100 - BOTTOM_SHARE },
      leaf(BOTTOM_ROW_ID, views, BOTTOM_SHARE),
    ]),
  }
}

/** The bottom row's roster in a *serialized* layout, empty when it has not got one. */
export function savedBottomViews(layout: SerializedDockview): string[] {
  const id = bottomRowId(layout.grid)
  if (!id) return []
  return leaves(layout.grid.root).find((zone) => zone.id === id)?.views ?? []
}

/**
 * Apply a rebuilt layout.
 *
 * What is left of a function that used to be fifty lines of smuggling the bottom row's
 * panes through a grid zone and back: it is a zone now, so `reuseExistingPanels` — which
 * preserves every pane the incoming layout names — covers it like everything else, and a
 * terminal keeps its shell across the switch because nothing about it is re-created. The
 * sync afterwards is the one thing dockview does not carry: `fromJSON` builds new groups,
 * so the pin and the classes have to go back on.
 */
export function applyLayout(api: DockviewApi, next: SerializedDockview): void {
  api.fromJSON(next, { reuseExistingPanels: true })
  syncBottomPanel(api)
}

/**
 * Move a pre-bottom-row layout's edge group into the bottom row.
 *
 * The migration off dockview's edge group, run on read (see `use-pane-layout`). Two things
 * have to happen and neither is optional: the `edgeGroups` entry has to *go*, because
 * dockview auto-creates an edge group for a serialized position it does not already have
 * one at — restoring the field would rebuild the very thing this replaces — and its roster
 * has to arrive somewhere, or `fromJSON` drops those panes on the floor.
 *
 * A pure function of the stored JSON, so a layout is migrated before dockview ever sees it,
 * and the result is written back on the next persist like any other layout.
 */
export function migrateEdgeGroup(
  layout: SerializedDockview
): SerializedDockview {
  if (!layout.edgeGroups) return layout
  const { edgeGroups, ...rest } = layout
  const bottom = edgeGroups.bottom?.group as { views?: unknown } | undefined
  const views = Array.isArray(bottom?.views)
    ? bottom.views.filter((view): view is string => typeof view === "string")
    : []
  // An empty edge group migrates to no bottom row, which is the same rule one level up: a
  // row exists exactly when something is in it.
  if (views.length === 0) return rest
  return { ...rest, grid: withBottomRow(rest.grid, views) }
}
