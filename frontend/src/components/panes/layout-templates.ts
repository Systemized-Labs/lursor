import type { DockviewApi, IDockviewPanel, SerializedDockview } from "dockview-react"

import { paneKindOf, type PaneKind } from "@/components/panes/pane-kinds"
import {
  HORIZONTAL,
  branch,
  leaf,
  leaves,
  type SerializedNode,
} from "@/components/panes/layout-shapes"
import {
  bottomPaneIds,
  gridPanes,
  withBottomRow,
} from "@/components/panes/bottom-panel"

export type TemplateId = "focus" | "split" | "bottom" | "workbench"

export interface TemplateDef {
  id: TemplateId
  label: string
  description: string
  /**
   * A tiny schematic for the dialog. Rows carry their own weight so the picture
   * matches the split the template actually applies — a bottom panel drawn as an equal
   * band would be advertising a layout this does not produce.
   */
  preview: { weight: number; columns: number[] }[]
  /**
   * The zone roster: what this template puts in each zone of its schematic, in
   * order, when there is not already a pane for it.
   *
   * A template can only *arrange* the panes that are open, so on its own it does
   * nothing at all from the state every workspace starts in — one chat pane, or
   * none. Picking "Workbench" is a request for a chat, a column beside it and a panel
   * below, not a request to be told there are not enough panes for two zones, so
   * the picker opens what the shape needs (see `fillsFor` in the layouts dialog).
   * Nothing is closed to make room.
   *
   * One entry per zone the `preview` draws, chat first: chat is the primary role in
   * every shape, so a layout built from nothing should get one before anything
   * else. Kinds already open are skipped rather than duplicated, so a roster may
   * carry more entries than the shape has zones — the extras are what it falls back
   * to when its first choice is already on screen.
   *
   * The bottom row is never filled from this roster. It is a zone the *user* counts, but
   * its pane is a shell and it goes at the bottom rather than in whichever zone the roster
   * is up to — a shape that wants one asks with {@link bottom} instead. A roster may still
   * name `terminal` for a *grid* zone, and does: a terminal in the column beside a chat is
   * a different thing from the panel below, and it is the pane most people want there.
   */
  fills: PaneKind[]
  /**
   * Whether this shape draws a bottom row.
   *
   * The band along the bottom of the schematic. Set it and the template expands the bottom
   * panel (opening a shell in it, if there is nothing down there); leave it and the bottom
   * row is left exactly as the user had it — a layout picker has no business closing a
   * terminal you were reading, which is also why a bottom row with panes in it is drawn by
   * every shape whether it asked for one or not.
   */
  bottom?: boolean
}

/**
 * The shapes, in the order the picker draws them.
 *
 * Ordered by what they add rather than by preference: one zone, then a second zone,
 * then the panel below, then both. Each step along the row is the one before it plus
 * something, which is also why none of them is called "Default" any more — a label
 * that means "start here" reads as wrong anywhere but first, and the row no longer has
 * a first among equals.
 */
export const TEMPLATES: TemplateDef[] = [
  {
    id: "focus",
    label: "Focus",
    description: "One zone. Everything else becomes a tab.",
    preview: [{ weight: 100, columns: [100] }],
    fills: ["chat"],
  },
  {
    id: "split",
    label: "Two panes",
    description: "Chat with a narrow column beside it.",
    preview: [{ weight: 100, columns: [62, 38] }],
    // A terminal in the side column, not a diff: the second zone is somewhere to *do*
    // something while the chat works, and a Changes pane is only worth a permanent zone
    // once there are changes to read. Preview is the fallback when a terminal is already up.
    fills: ["chat", "terminal", "preview"],
  },
  {
    id: "bottom",
    label: "Terminal below",
    description: "One zone above, terminals in a wide panel below.",
    preview: [
      { weight: 64, columns: [100] },
      { weight: 36, columns: [100] },
    ],
    // One zone to fill, because the second band of the schematic is the bottom row — it
    // takes a shell rather than a pane off the roster (see {@link gridZones}).
    fills: ["chat"],
    bottom: true,
  },
  {
    id: "workbench",
    label: "Workbench",
    description: "Chat, a column beside it, and terminals below.",
    preview: [
      { weight: 64, columns: [62, 38] },
      { weight: 36, columns: [100] },
    ],
    // "Two panes" with a panel below: the arrangement for actually working in a repo,
    // where you are watching the app beside the conversation and running things under
    // both. Two zones to fill; the third band is the bottom row.
    //
    // Preview leads here where "Two panes" leads with a terminal, because this shape
    // already puts shells at the bottom — the roster is counted over the *grid* panes
    // (`fillsFor`), so a terminal first would open a second one in the column beside the
    // chat and the two zones would say the same thing.
    fills: ["chat", "preview", "terminal"],
    bottom: true,
  },
]

/**
 * How many zones of a template's schematic take a pane off its {@link TemplateDef.fills}
 * roster.
 *
 * Read off the picture rather than declared twice: the schematic is what the user is
 * promised, so it is also the right thing to measure a shortfall against. Minus the bottom
 * band, which is drawn in the same picture and is a zone like any other — but one whose
 * pane is a shell, requested separately, because it belongs at the bottom rather than in
 * whichever zone the roster is up to.
 *
 * Lives here, beside the definitions, because {@link buildTemplate} needs it too — it
 * used to name the one-zone shapes to decide whether to build one zone or a split, which
 * silently gave every *new* template a split whether its schematic drew one or not.
 */
export const gridZones = (template: TemplateDef): number =>
  template.preview.reduce((sum, row) => sum + row.columns.length, 0) -
  (template.bottom ? 1 : 0)

/**
 * Split the open panes into the two roles every template arranges.
 *
 * "Primary" is chat: it is what the other panes are *about*, so it keeps the
 * biggest zone in every shape. Everything else is secondary and shares whatever
 * the template gives it. Order within each list follows the current layout's own
 * order, so applying a template rearranges zones without reshuffling tabs.
 */
function roles(panels: IDockviewPanel[]) {
  const ids = panels.map((panel) => panel.api.id)
  const primary = panels
    .filter((panel) => paneKindOf(panel) === "chat")
    .map((panel) => panel.api.id)
  return { ids, primary }
}

/**
 * Build a template over the panes that are *currently* open.
 *
 * **A template cannot be a frozen constant** — the finding from Phase 0, recorded
 * in the plan's §3.7. `fromJSON` destroys any panel the incoming layout does not
 * mention, `reuseExistingPanels` or not: the flag preserves panels the new layout
 * *also* lists, and nothing more. So a template is a function of the live pane set
 * that places every open pane somewhere. A constant would silently close whatever
 * it forgot to name, and "switching to Focus killed my terminal" is not a bug
 * anyone would attribute to a layout picker.
 *
 * The bottom row is a row of that grid, so it is arranged along with everything else — but
 * from the *live* bottom row's roster rather than from the shape, because its panes are the
 * ones the user put down there. A shape draws the band whenever there is something at the
 * bottom, whether it asked for one or not: a layout picker has no business closing a
 * terminal you were reading. What the shape's own `bottom` flag decides is whether the
 * panel is *expanded* (see `applyTemplate`).
 *
 * Returns null when there is nothing to arrange, so a caller never hands dockview
 * an empty grid.
 */
export function buildTemplate(
  id: TemplateId,
  api: DockviewApi,
  activePanelId?: string
): SerializedDockview | null {
  const current = api.toJSON()
  const def = TEMPLATES.find((template) => template.id === id)
  const { ids, primary } = roles(gridPanes(api))
  if (ids.length === 0) return null

  let root: SerializedNode

  // How many zones the shape draws, and never more than there are panes to put in
  // them: an empty zone is not a legal layout. Read from the schematic rather than
  // matched against a list of ids, so a template's picture and its behaviour cannot
  // disagree — which is how a new shape used to inherit whichever branch it happened
  // to fall through to.
  if ((def ? gridZones(def) : 1) <= 1 || ids.length === 1) {
    // Everything tabbed into one zone. Nothing is dropped — that is the whole
    // point of building this from the live set.
    root = branch([leaf("main", ids, 100)])
  } else {
    const main = primary.length ? primary : [ids[0]]
    const side = ids.filter((paneId) => !main.includes(paneId))
    root = side.length
      ? branch([leaf("main", main, 62), leaf("side", side, 38)])
      : branch([leaf("main", main, 100)])
  }

  // The columns first, then the bottom row under all of them — `withBottomRow` is what
  // flips the root to a pair of rows, and a no-op when there is nothing down there.
  const grid = withBottomRow(
    { root, height: 1000, width: 1000, orientation: HORIZONTAL },
    bottomPaneIds(api)
  )

  // Keep the focused pane focused across the switch: a layout picker should
  // rearrange the window, not move the cursor. Read off the finished tree, so a pane in
  // the bottom row resolves to the bottom row.
  const holder = activePanelId ? findGroupFor(grid.root, activePanelId) : null

  return { ...current, grid, activeGroup: holder ?? "main" }
}

/** Which group in a built tree holds `panelId`. */
function findGroupFor(node: SerializedNode, panelId: string): string | null {
  return leaves(node).find((zone) => zone.views.includes(panelId))?.id ?? null
}
