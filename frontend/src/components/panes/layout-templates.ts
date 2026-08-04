import type { IDockviewPanel, SerializedDockview } from "dockview-react"

import type { PaneParams } from "@/components/panes/pane-kinds"
import {
  HORIZONTAL,
  VERTICAL,
  branch,
  leaf,
  panelState,
  type SerializedNode,
} from "@/components/panes/layout-shapes"

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
}

export const TEMPLATES: TemplateDef[] = [
  {
    id: "default",
    label: "Default",
    description: "Chat with a narrow column beside it.",
    preview: [{ weight: 100, columns: [62, 38] }],
  },
  {
    id: "focus",
    label: "Focus",
    description: "One zone. Everything else becomes a tab.",
    preview: [{ weight: 100, columns: [100] }],
  },
  {
    id: "deck",
    label: "Terminal deck",
    description: "Chat above, a wide deck below it.",
    preview: [
      { weight: 64, columns: [100] },
      { weight: 36, columns: [100] },
    ],
  },
  {
    id: "quad",
    label: "Quad",
    description: "Two columns, each split in two.",
    preview: [
      { weight: 50, columns: [50, 50] },
      { weight: 50, columns: [50, 50] },
    ],
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
 * Returns null when there is nothing to arrange, so a caller never hands dockview
 * an empty grid.
 */
export function buildTemplate(
  id: TemplateId,
  panels: IDockviewPanel[],
  activePanelId?: string
): SerializedDockview | null {
  const { ids, primary } = roles(panels)
  if (ids.length === 0) return null

  const panelStates = Object.fromEntries(
    panels.map((panel) => [
      panel.api.id,
      panelState(panel.api.id, panel.params as PaneParams),
    ])
  )

  let orientation = HORIZONTAL
  let root: SerializedNode
  let activeGroup = "main"

  if (id === "focus" || ids.length === 1) {
    // Everything tabbed into one zone. Nothing is dropped — that is the whole
    // point of building this from the live set.
    root = branch([leaf("main", ids, 100)])
  } else if (id === "deck") {
    orientation = VERTICAL
    const top = primary.length ? primary : [ids[0]]
    const bottom = ids.filter((paneId) => !top.includes(paneId))
    root = bottom.length
      ? branch([leaf("main", top, 64), leaf("deck", bottom, 36)])
      : branch([leaf("main", top, 100)])
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
    grid: { root, height: 1000, width: 1000, orientation },
    panels: panelStates,
    activeGroup,
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
