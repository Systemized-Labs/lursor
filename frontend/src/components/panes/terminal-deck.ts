import type {
  DockviewApi,
  DockviewGroupPanel,
  DockviewIDisposable,
  DockviewPanelRenderer,
  IDockviewPanel,
  PanelTransfer,
  SerializedDockview,
  SerializedEdgeGroups,
} from "dockview-react"

import { leafIds, mapLeaves } from "@/components/panes/layout-shapes"
import { paneKindOf, type PaneParams } from "@/components/panes/pane-kinds"

/**
 * The terminal deck: a drawer across the bottom of the window that puts itself
 * away without closing what is in it.
 *
 * This is dockview's **edge group**, not a zone of the grid, and that is the whole
 * point. An edge group lives in the shell *around* the grid, and while it is
 * collapsed dockview pins its minimum and maximum size to the height of its own tab
 * strip — so a window resize, a sidebar toggle and a sash drag all leave a put-away
 * drawer exactly where it was put. The grid cannot do that: it lays out
 * proportionally, so a zone squashed onto its strip holds a 36/H share of every
 * resize to come and leaks back open a few pixels at a time.
 *
 * Everything else follows from dockview owning the state rather than us inferring
 * it: `collapse()`, `expand()` and `isCollapsed()` replace guessing from a height,
 * the strip is measured by a ResizeObserver so a taller theme still collapses
 * exactly onto it, the height to come back to is remembered as the edge group's
 * `lastExpandedSize`, and all of it round-trips through `toJSON().edgeGroups`.
 * There is nothing here to persist ourselves and no collapsed flag to keep honest.
 *
 * **Type-only imports from dockview**, like `layout-shapes`: this module is reached
 * from `use-pane-layout`, which the shell imports on every route, so a value import
 * here would pull dockview into the entry chunk past the lazy pane host.
 */

/** Dockview allows one edge group per side. The deck is the bottom one. */
const EDGE = "bottom" as const

/** The deck's entry in a serialized layout: its geometry, and its roster. */
type DeckState = NonNullable<SerializedEdgeGroups[typeof EDGE]>

/** The deck's group id, which is what a saved layout's `edgeGroups` entry names. */
export const DECK_ID = "deck"

/**
 * How tall the deck opens the first time.
 *
 * Only ever the first time: after that dockview remembers the height the drawer was
 * last left at and restores it on expand, across reloads included.
 */
const DECK_INITIAL_HEIGHT = 260

/**
 * Create the deck, once per dockview instance.
 *
 * Called *before* the first `fromJSON`, and that ordering is load-bearing in both
 * directions. `fromJSON` clears the layout first, and clearing an edge group only
 * empties it — the group is structural and survives — so the deck outlives every
 * layout switch and workspace change without being rebuilt. And dockview only
 * auto-creates an edge group for a serialized position it does not already have
 * one at, with nothing but an id: creating it ourselves first is what makes the
 * options below apply to a restored layout too.
 */
export function ensureDeck(api: DockviewApi): void {
  if (api.getEdgeGroup(EDGE)) return
  const deck = api.addEdgeGroup(EDGE, {
    id: DECK_ID,
    initialSize: DECK_INITIAL_HEIGHT,
    // Closed until something is put in it, or until a saved layout says otherwise.
    collapsed: true,
  })
  // Tabs above the shells, not under them. An edge group defaults its header to
  // its own side, which for the bottom edge means a strip along the window's
  // bottom border; every zone in the grid has its tabs on top and the deck is not
  // different enough to be inconsistent about.
  deck.setHeaderPosition("top")
}

/** The deck's group, once {@link ensureDeck} has run. */
export function deckGroup(api: DockviewApi): DockviewGroupPanel | undefined {
  // By location rather than by id: the location is what dockview itself keys the
  // edge behaviour off, so this cannot drift from what is actually the deck.
  return api.groups.find((group) => group.api.location.type === "edge")
}

/** Whether the deck is holding anything. */
export function isDeckEmpty(api: DockviewApi): boolean {
  const group = deckGroup(api)
  return !group || group.panels.length === 0
}

/**
 * The panes in the grid — which is every pane the templates arrange.
 *
 * The deck's terminals are panes like any other and `api.panels` includes them, but
 * they are not part of the *grid*: dealing them into zones is what would tear a
 * running shell out of the drawer the user put it in.
 */
export function gridPanels(api: DockviewApi): IDockviewPanel[] {
  return api.panels.filter(
    (panel) => panel.api.group.api.location.type === "grid"
  )
}

/**
 * Whether the deck is in the window at all — the third state, past collapsed.
 *
 * Collapsed leaves the strip as a handle; hidden takes even that away, which is what
 * the strip's `×` is for and what a *global* layout gets unconditionally (no
 * workspace, so no directory to run a shell in, so no deck). Dockview serializes it
 * as the edge group's `visible`, so a deck someone closed stays closed across a
 * reload without a key of our own.
 *
 * The way back is asking for a terminal: every path that opens or reveals one goes
 * through {@link revealDeck}, which brings the deck back with it.
 */
export function setDeckVisible(api: DockviewApi, visible: boolean): void {
  if (api.isEdgeGroupVisible(EDGE) === visible) return
  api.setEdgeGroupVisible(EDGE, visible)
}

export function isDeckCollapsed(api: DockviewApi): boolean {
  return api.getEdgeGroup(EDGE)?.isCollapsed() ?? true
}

/**
 * Whether the drawer is in the window *and* open — showing what is in it.
 *
 * The state in which dockview's own drop targets are the better ones: an open drawer
 * is a group on screen, so dragging a pane onto its strip already puts it in there,
 * at the tab index you dropped it on. {@link dropInDeck}'s band is for the other two
 * states, where the drawer is put away or gone and there is nothing to aim at.
 */
export function isDeckOpen(api: DockviewApi): boolean {
  return api.isEdgeGroupVisible(EDGE) && !isDeckCollapsed(api)
}

/**
 * Close the deck: its panes go, and the strip goes with them.
 *
 * The `×` beside the collapse caret, and the difference between the two is the whole
 * point of having both — the caret puts the drawer away with everything still running
 * in it, this one is done with it. The shells are closed rather than left running
 * behind a hidden strip: "close" already means close on a pane's own `×`, and a
 * terminal nobody can see or reach is not a state worth serializing.
 */
export function closeDeck(api: DockviewApi): void {
  const group = deckGroup(api)
  // A copy: closing mutates the group's own list as it goes.
  for (const panel of [...(group?.panels ?? [])]) panel.api.close()
  setDeckVisible(api, false)
}

/**
 * Open the deck for something that is about to be shown in it.
 *
 * A no-op when it is already open, so callers do not have to ask first — and the
 * reason every path that reveals a terminal goes through here: activating a tab
 * inside a closed drawer would make it the active tab of a 36px strip, and the app
 * would consider the request served while the user sees nothing change.
 */
export function revealDeck(api: DockviewApi): void {
  const deck = api.getEdgeGroup(EDGE)
  if (!deck) return
  setDeckVisible(api, true)
  deck.expand()
}

/**
 * A pane to open, before anything has said where it goes.
 *
 * Spelled out rather than borrowed from `addPanel`: its options type is a union
 * discriminated on *placement*, and spreading one member of it into another is the
 * one thing that union will not let you do.
 */
export interface DeckPane {
  id: string
  component: string
  tabComponent?: string
  title?: string
  renderer?: DockviewPanelRenderer
  params?: PaneParams
}

/** Add a pane to the deck and open the drawer on it. */
export function openInDeck(api: DockviewApi, panel: DeckPane): void {
  ensureDeck(api)
  api.addPanel({
    ...panel,
    position: { referenceGroup: DECK_ID, direction: "within" },
  })
  revealDeck(api)
}

/**
 * Move a *dragged* pane into the deck, and open the drawer on it.
 *
 * The other half of the drawer's drop band (`DrawerDropZone` in `pane-host`): the band
 * decides where the drop counts, this decides what a drop means. Dockview's own targets
 * cannot express it — a drop is resolved against the group under the cursor, and the
 * deck is not a group in the grid, so the closest a drag could get to "put this along
 * the bottom" was splitting the bottom-most zone in two.
 *
 * `data` is dockview's transfer object, which names either one panel or a whole group:
 * a tab drag carries a `panelId`, a group drag (the void space beside the tabs) carries
 * only its `groupId` and means every pane in it. Both are moved rather than re-created,
 * so a running shell and a scrolled preview arrive exactly as they left.
 *
 * Revealing the drawer afterwards is the point of routing this through here rather than
 * letting the moves stand on their own: a pane dropped into a drawer that is put away —
 * or one the `×` took out of the window entirely — would otherwise vanish on drop.
 */
export function dropInDeck(api: DockviewApi, data: PanelTransfer): void {
  // Another dockview instance's drag (a popout window's). Its panels are not ours to
  // move, and its ids may well collide with ours.
  if (data.viewId !== api.id) return
  ensureDeck(api)
  const group = deckGroup(api)
  if (!group) return

  const panel = data.panelId ? api.getPanel(data.panelId) : undefined
  // A copy of the group's roster: moving a pane out mutates the list being read, and
  // dockview disposes the group once the last one leaves.
  const dragged = panel
    ? [panel]
    : [...(api.groups.find((g) => g.api.id === data.groupId)?.panels ?? [])]
  if (dragged.length === 0) return

  for (const dropped of dragged) {
    dropped.api.moveTo({ group, position: "center", skipSetActive: true })
  }
  revealDeck(api)
  // Then focus what was dropped. Unlike a template switch — which rearranges the window
  // and leaves the cursor alone — a drag is a request to put *this* pane there, so the
  // drawer should open on it rather than on whichever tab it happens to land beside.
  dragged[dragged.length - 1].api.setActive()
}

/**
 * Take over the drops that would put a pane across the whole bottom of the grid.
 *
 * The band in `pane-host` is an *affordance*; this is the rule. Dockview resolves a drop
 * against the group under the cursor, and a drop on the lower fifth of a zone splits it
 * — so a zone spanning the full width gets a full-width row beneath it, which is a
 * drawer in every respect a user can see and in none that the app agrees with: it is a
 * grid zone, so its strip has a `+` and no caret and no `×`, and the real drawer is still
 * sitting collapsed underneath it. Dragging to the bottom would produce one or the other
 * depending on a few dozen pixels.
 *
 * So a full-width bottom row is not a layout this app has. Nothing else builds one either
 * — every template splits columns and leaves the bottom to the deck (see `buildTemplate`)
 * — and this is the one path that could, so it is claimed here instead.
 *
 * **Only when the row would span the grid**: dropping below a *column* stacks two zones
 * inside it, which is a real arrangement and is left alone. That is the whole of
 * {@link spansGridBottom}.
 *
 * Returns the subscription for the caller to dispose.
 */
export function claimBottomDrops(api: DockviewApi): DockviewIDisposable {
  return api.onWillDrop((event) => {
    if (event.kind !== "content" || event.position !== "bottom") return
    const group = event.group
    if (!group || group.api.location.type !== "grid") return
    if (!spansGridBottom(api, group)) return
    const data = event.getData()
    // Not a pane — a file from the tree, say. Dockview has its own answer for those.
    if (!data) return
    event.preventDefault()
    dropInDeck(api, data)
  })
}

/**
 * Whether a row added below `group` would run the full width of the grid's bottom.
 *
 * Measured off the live group boxes rather than walked in the serialized tree: "spans the
 * bottom" is a question about the picture on screen, and the tree answers a subtly
 * different one — a zone can be the last leaf of the root and still have a column beside
 * it. The grid's own box is the union of its zones, which is exactly what the deck sits
 * under.
 */
function spansGridBottom(
  api: DockviewApi,
  group: DockviewGroupPanel
): boolean {
  const boxes = api.groups
    .filter((candidate) => candidate.api.location.type === "grid")
    .map((candidate) => candidate.element.getBoundingClientRect())
  if (boxes.length === 0) return false
  const rect = group.element.getBoundingClientRect()
  // Within a sash: the gridview leaves a couple of pixels between views.
  const near = (a: number, b: number) => Math.abs(a - b) <= 4
  return (
    near(rect.left, Math.min(...boxes.map((box) => box.left))) &&
    near(rect.right, Math.max(...boxes.map((box) => box.right))) &&
    near(rect.bottom, Math.max(...boxes.map((box) => box.bottom)))
  )
}

/**
 * Focus a pane, opening the deck first if that is where it lives.
 *
 * The deck is a real group, so anything can be dragged into it — a Changes pane
 * parked below a chat is a reasonable thing to want. Which means any path that
 * reveals a pane on the user's behalf (a route, a link, "open this file here") can
 * land on one inside a closed drawer, and has to open it.
 */
export function revealPanel(api: DockviewApi, panel: IDockviewPanel): void {
  if (panel.api.group.api.location.type === "edge") revealDeck(api)
  panel.api.setActive()
}

/**
 * Move terminals out of the grid and into the deck.
 *
 * The migration for a layout saved before the deck existed, where terminals are
 * zones of the grid. Self-limiting rather than flagged: every layout written since
 * carries an `edgeGroups` entry, so the caller runs this exactly for the ones that
 * do not (see `load` in `use-pane-layout`). Returns whether it moved anything —
 * a deck that just inherited a running shell should be open, not put away.
 */
export function adoptGridTerminals(api: DockviewApi): boolean {
  const group = deckGroup(api)
  if (!group) return false
  const strays = gridPanels(api).filter(
    (panel) => paneKindOf(panel) === "terminal"
  )
  for (const panel of strays) {
    // `skipSetActive`: a migration should not move the cursor off whatever the
    // restored layout had focused.
    panel.api.moveTo({ group, position: "center", skipSetActive: true })
  }
  return strays.length > 0
}

/**
 * The deck's changes that dockview does not report as layout changes.
 *
 * `onDidLayoutChange` is the *grid's* event, and the deck is not in the grid: putting
 * the drawer away and dragging its edge both leave it silent. Persistence rides on
 * that event, so without these two a collapsed deck comes back open on the next
 * reload — dockview serializes the state faithfully, nothing had asked it to.
 *
 * Returns the subscriptions for the caller to dispose alongside its own.
 */
export function watchDeck(
  api: DockviewApi,
  listener: () => void
): DockviewIDisposable[] {
  const deck = api.getEdgeGroup(EDGE)
  if (!deck) return []
  return [
    deck.onDidCollapsedChange(() => listener()),
    // The height the drawer was left at, after a drag of its edge.
    deck.onDidDimensionsChange(() => listener()),
  ]
}

/**
 * How many shells a *serialized* deck was holding.
 *
 * For a saved arrangement, which has to answer "did this layout have a terminal in
 * it?" without a live deck to ask. The roster itself is useless — those ids name the
 * shells of the workspace it was saved in — but its *length* is the whole question,
 * and it is the one part of a saved deck that transfers.
 */
export function serializedDeckSize(layout: SerializedDockview): number {
  const group = layout.edgeGroups?.[EDGE]?.group as
    | { views?: unknown }
    | undefined
  return Array.isArray(group?.views) ? group.views.length : 0
}

/**
 * A serialized deck, opened — for a layout whose schematic promises it is showing.
 *
 * Read as *intent* by {@link applyLayout}, which is the only thing that should hand a
 * rebuilt layout to dockview. Dropping `collapsed` is how "open" is spelled:
 * `toJSON` records the expanded height as `size` even while collapsed, precisely so
 * restoring without the flag reopens it where the user last left it.
 */
export function withDeckOpen(
  edgeGroups: SerializedEdgeGroups | undefined
): SerializedEdgeGroups | undefined {
  const bottom = edgeGroups?.[EDGE]
  if (!bottom) return edgeGroups
  return {
    ...edgeGroups,
    [EDGE]: { ...bottom, visible: true, collapsed: undefined },
  }
}

/**
 * Apply a rebuilt layout without killing the shells in the deck.
 *
 * **`fromJSON` destroys the deck's panes, and `reuseExistingPanels` does not save
 * them.** The flag preserves panes the incoming layout names *in the grid*; the deck
 * is not in the grid, and the clear that `fromJSON` opens with empties edge groups
 * unconditionally. Restored from their serialized state afterwards they are new
 * panes with old ids: a fresh PTY, a lost session, and the previous one left running
 * with nowhere to be. Which is §3.7 again, one level out — the layout picker's whole
 * promise is that a terminal does not lose its shell.
 *
 * So the deck's panes ride through the grid. Named in a zone of the incoming layout,
 * they are exactly what `reuseExistingPanels` keeps alive, and they are moved back
 * the moment it is in place. `renderer: 'always'` is what makes the detour
 * invisible: a pane's DOM node is never reparented, so a shell cannot tell it was
 * briefly somewhere else.
 *
 * The deck's own state is read from `next.edgeGroups` as an *intent*: its geometry —
 * shown or not, put away or not, and at what height — is restored, while its roster
 * is discarded in favour of the live shells carried through above.
 */
export function applyLayout(api: DockviewApi, next: SerializedDockview): void {
  const carried = deckGroup(api)?.panels.map((panel) => panel.api.id) ?? []
  // Absent `edgeGroups` — or absent a deck to apply them to — the layout says nothing
  // about the drawer and it stays as the user had it. Clearing empties the deck, which
  // trips dockview's collapse-when-empty, so this has to be re-asserted either way.
  const intent = api.getEdgeGroup(EDGE) ? next.edgeGroups?.[EDGE] : undefined
  const wantVisible = intent?.visible ?? api.isEdgeGroupVisible(EDGE)
  // A drawer that is not in the window is not open, whatever its collapsed flag says
  // — a deck is hidden by closing it, which empties it first, so that flag is a
  // leftover from before the shells went rather than a state anyone chose.
  const wantOpen = intent
    ? intent.visible && !intent.collapsed
    : !isDeckCollapsed(api)

  api.fromJSON(withCarried(next, carried, intent), { reuseExistingPanels: true })

  const group = deckGroup(api)
  if (group) {
    for (const id of carried) {
      api
        .getPanel(id)
        ?.api.moveTo({ group, position: "center", skipSetActive: true })
    }
  }

  // A layout that had the drawer closed is honoured, but never at the price of a
  // running shell: hiding takes even the strip away, and `closeDeck` is the only
  // thing allowed to end a terminal. With shells in it, "closed" degrades to "put
  // away" — recoverable, and the shells keep running.
  setDeckVisible(api, wantVisible || carried.length > 0)
  // Nothing to show is not a reason to open: an expanded empty drawer is a band of
  // background with a `+` in the corner.
  if (wantOpen && carried.length > 0) revealDeck(api)
  else api.getEdgeGroup(EDGE)?.collapse()
}

/**
 * The layout to hand `fromJSON`: the deck's panes parked in a zone, and the deck's
 * own geometry with an empty roster.
 *
 * The panes go in the zone the layout marks active, and at the end of its tab list so
 * the zone opens on the tab the template chose rather than on a terminal in transit.
 *
 * The geometry has to go through dockview rather than be re-applied afterwards,
 * because `size` — the height `expand()` comes back to — is reachable *only* through
 * `fromJSON`; no public method sets it. The roster is emptied on the way, since that
 * is the one part dockview would rebuild from serialized state, and a rebuilt terminal
 * is a new PTY and a lost session (see above). So: geometry from the layout, panes
 * from the live deck.
 */
function withCarried(
  next: SerializedDockview,
  carried: string[],
  intent: DeckState | undefined
): SerializedDockview {
  const { edgeGroups: _saved, ...base } = next
  const rest: SerializedDockview = intent
    ? {
        ...base,
        edgeGroups: {
          [EDGE]: {
            size: intent.size,
            visible: intent.visible,
            collapsed: intent.collapsed,
          },
        },
      }
    : base
  if (carried.length === 0) return rest

  const host = leafIds(rest.grid.root)
  const target = host.find((id) => id === rest.activeGroup) ?? host[0]
  if (!target) return rest

  return {
    ...rest,
    grid: {
      ...rest.grid,
      root: mapLeaves(rest.grid.root, (leaf) =>
        leaf.id === target
          ? { ...leaf, views: [...leaf.views, ...carried] }
          : leaf
      ),
    },
  }
}
