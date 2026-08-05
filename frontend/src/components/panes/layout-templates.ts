import type { DockviewApi, IDockviewPanel, SerializedDockview } from "dockview-react"

import type { PaneKind, PaneParams } from "@/components/panes/pane-kinds"
import {
  HORIZONTAL,
  branch,
  leaf,
  type SerializedNode,
} from "@/components/panes/layout-shapes"
import { gridPanels, withDeckOpen } from "@/components/panes/terminal-deck"

export type TemplateId = "focus" | "split" | "deck" | "workbench"

export interface TemplateDef {
  id: TemplateId
  label: string
  description: string
  /**
   * A tiny schematic for the dialog. Rows carry their own weight so the picture
   * matches the split the template actually applies — a deck drawn as two equal
   * bands would be advertising a layout this does not produce.
   */
  preview: { weight: number; columns: number[] }[]
  /**
   * The zone roster: what this template puts in each zone of its schematic, in
   * order, when there is not already a pane for it.
   *
   * A template can only *arrange* the panes that are open, so on its own it does
   * nothing at all from the state every workspace starts in — one chat pane, or
   * none. Picking "Workbench" is a request for a chat, a column beside it and a
   * drawer, not a request to be told there are not enough panes for two zones, so
   * the picker opens what the shape needs (see `fillsFor` in the layouts dialog).
   * Nothing is closed to make room.
   *
   * One entry per zone the `preview` draws, chat first: chat is the primary role in
   * every shape, so a layout built from nothing should get one before anything
   * else. Kinds already open are skipped rather than duplicated.
   *
   * Terminals are never in here. The deck is not a zone of the grid, so a shape that
   * wants one asks for it with {@link deck} instead.
   */
  fills: PaneKind[]
  /**
   * Whether this shape shows the terminal deck.
   *
   * The band along the bottom of the schematic. Set it and the template opens the
   * drawer (and a shell for it, if the deck is empty); leave it and the deck is left
   * exactly as the user had it — a layout picker has no business closing a terminal
   * you were reading.
   */
  deck?: boolean
}

/**
 * The shapes, in the order the picker draws them.
 *
 * Ordered by what they add rather than by preference: one zone, then a second zone,
 * then the drawer, then both. Each step along the row is the one before it plus
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
    fills: ["chat", "changes"],
  },
  {
    id: "deck",
    label: "Terminal deck",
    description: "One zone above, terminals in a wide deck below.",
    preview: [
      { weight: 64, columns: [100] },
      { weight: 36, columns: [100] },
    ],
    // One zone, because the deck is the second band of the schematic — it is the
    // shell's bottom edge rather than a cell of the grid, so the grid above it has
    // nothing left to split.
    fills: ["chat"],
    deck: true,
  },
  {
    id: "workbench",
    label: "Workbench",
    description: "Chat, a column beside it, and terminals below.",
    preview: [
      { weight: 64, columns: [62, 38] },
      { weight: 36, columns: [100] },
    ],
    // "Two panes" with the drawer out: the arrangement for actually working in a repo,
    // where you are reading a diff beside the conversation and running things under
    // both. Two grid zones — the third band is the deck, which is the shell's bottom
    // edge and asks for a shell rather than a cell (see {@link gridZones}).
    fills: ["chat", "changes"],
    deck: true,
  },
]

/**
 * How many *grid* zones a template's schematic advertises.
 *
 * Read off the picture rather than declared twice: the schematic is what the user is
 * promised, so it is also the right thing to measure a shortfall against. Minus the
 * deck's band, which is drawn in the same picture but is the shell's bottom edge rather
 * than a zone the grid has to find a pane for.
 *
 * Lives here, beside the definitions, because {@link buildTemplate} needs it too — it
 * used to branch on `id === "focus" || id === "deck"` to decide whether to build one
 * zone or a split, which silently gave every *new* template a split whether its
 * schematic drew one or not.
 */
export const gridZones = (template: TemplateDef): number =>
  template.preview.reduce((sum, row) => sum + row.columns.length, 0) -
  (template.deck ? 1 : 0)

/**
 * Split the open panes into the two roles every template arranges.
 *
 * "Primary" is chat: it is what the other panes are *about*, so it keeps the
 * biggest zone in every shape. Everything else is secondary and shares whatever
 * the template gives it. Order within each list follows the current layout's own
 * order, so applying a template rearranges zones without reshuffling tabs.
 */
function roles(panels: IDockviewPanel[]) {
  const kindOf = (panel: IDockviewPanel) =>
    (panel.params as PaneParams | undefined)?.kind
  const ids = panels.map((panel) => panel.api.id)
  const primary = panels.filter((p) => kindOf(p) === "chat").map((p) => p.api.id)
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
 * The deck is not arranged, only opened. It is the shell's bottom edge rather than a
 * cell of the grid, so only the grid is rebuilt here: the rest of the layout — every
 * pane's state, and the deck's own — is the live `toJSON()`, passed through. A shape
 * that rebuilt just the grid's panels would leave the deck's shells named nowhere,
 * and `fromJSON` destroys what a layout does not mention. Keeping them *alive* across
 * the switch takes more than naming them; see `applyLayout`, which is what a caller
 * hands this to.
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
  const { ids, primary } = roles(gridPanels(api))
  if (ids.length === 0) return null

  let root: SerializedNode
  let activeGroup = "main"

  // How many zones the shape draws, and never more than there are panes to put in
  // them: an empty zone is not a legal layout. Read from the schematic rather than
  // matched against a list of ids, so a template's picture and its behaviour cannot
  // disagree — which is how a new shape used to inherit whichever branch it happened
  // to fall through to.
  if ((def ? gridZones(def) : 1) <= 1 || ids.length === 1) {
    // Everything tabbed into one zone. Nothing is dropped — that is the whole
    // point of building this from the live set. A shape that draws the deck shares
    // this grid: its band is the drawer below, opened at the end of this function.
    root = branch([leaf("main", ids, 100)])
  } else {
    const main = primary.length ? primary : [ids[0]]
    const side = ids.filter((paneId) => !main.includes(paneId))
    root = side.length
      ? branch([leaf("main", main, 62), leaf("side", side, 38)])
      : branch([leaf("main", main, 100)])
  }

  // Keep the focused pane focused across the switch: a layout picker should
  // rearrange the window, not move the cursor.
  if (activePanelId) {
    const holder = findGroupFor(root, activePanelId)
    if (holder) activeGroup = holder
  }

  return {
    ...current,
    // Every shape splits columns first: a template that needed a row would nest a
    // branch, and the one that used to — the deck — is the shell's edge now.
    grid: { root, height: 1000, width: 1000, orientation: HORIZONTAL },
    activeGroup,
    // Off the template's own `deck` flag, not its id. Keyed on `id === "deck"`, the
    // one thing a new drawer-showing shape would not do is show the drawer.
    edgeGroups: def?.deck ? withDeckOpen(current.edgeGroups) : current.edgeGroups,
  }
}

/** Which group in a built tree holds `panelId`. */
function findGroupFor(node: SerializedNode, panelId: string): string | null {
  if (node.type === "leaf") {
    const data = node.data as { id: string; views: string[] }
    return data.views.includes(panelId) ? data.id : null
  }
  for (const child of node.data as SerializedNode[]) {
    const found = findGroupFor(child, panelId)
    if (found) return found
  }
  return null
}
