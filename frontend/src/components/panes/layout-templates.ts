import type { DockviewApi, IDockviewPanel, SerializedDockview } from "dockview-react"

import type { PaneKind, PaneParams } from "@/components/panes/pane-kinds"
import {
  HORIZONTAL,
  branch,
  leaf,
  type SerializedNode,
} from "@/components/panes/layout-shapes"
import { gridPanels, withDeckOpen } from "@/components/panes/terminal-deck"

export type TemplateId = "default" | "focus" | "deck" | "quad"

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
   * none. Picking "Quad" is a request for four zones, not a request to be told
   * there are not enough panes for four zones, so the picker opens what the shape
   * needs (see `fillsFor` in the layouts dialog). Nothing is closed to make room.
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

export const TEMPLATES: TemplateDef[] = [
  {
    id: "default",
    label: "Default",
    description: "Chat with a narrow column beside it.",
    preview: [{ weight: 100, columns: [62, 38] }],
    fills: ["chat", "changes"],
  },
  {
    id: "focus",
    label: "Focus",
    description: "One zone. Everything else becomes a tab.",
    preview: [{ weight: 100, columns: [100] }],
    fills: ["chat"],
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
    id: "quad",
    label: "Quad",
    description: "Two columns, each split in two.",
    preview: [
      { weight: 50, columns: [50, 50] },
      { weight: 50, columns: [50, 50] },
    ],
    // The four surfaces a quad is for: watching a change land while you work on it,
    // with the running app beside it. A terminal joins from the deck, not a cell.
    fills: ["chat", "changes", "file", "preview"],
  },
]

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

/** Distribute `ids` into at most `n` non-empty buckets, in order. */
function buckets(ids: string[], n: number): string[][] {
  const count = Math.min(n, ids.length)
  if (count === 0) return []
  const out: string[][] = Array.from({ length: count }, () => [])
  ids.forEach((id, i) => out[i % count].push(id))
  return out
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
  const { ids, primary } = roles(gridPanels(api))
  if (ids.length === 0) return null

  let root: SerializedNode
  let activeGroup = "main"

  if (id === "focus" || id === "deck" || ids.length === 1) {
    // Everything tabbed into one zone. Nothing is dropped — that is the whole
    // point of building this from the live set. The deck shares this grid: its
    // band is the drawer below, opened at the end of this function.
    root = branch([leaf("main", ids, 100)])
  } else if (id === "quad") {
    // Chat takes the first cell; the rest fill the remaining three.
    const head = primary.length ? [primary[0]] : [ids[0]]
    const rest = ids.filter((paneId) => !head.includes(paneId))
    const cells = [head, ...buckets(rest, 3)]
    const columns = [cells.slice(0, 2), cells.slice(2)].filter((c) => c.length)
    root = branch(
      columns.map((column, ci) =>
        column.length === 1
          ? leaf(ci === 0 ? "main" : `quad-${ci}-0`, column[0], 50)
          : branch(
              column.map((views, ri) =>
                leaf(
                  ci === 0 && ri === 0 ? "main" : `quad-${ci}-${ri}`,
                  views,
                  50
                )
              ),
              50
            )
      )
    )
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
    edgeGroups: id === "deck" ? withDeckOpen(current.edgeGroups) : current.edgeGroups,
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
