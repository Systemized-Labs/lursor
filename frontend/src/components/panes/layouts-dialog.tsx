import { useCallback, useState } from "react"
import {
  ArrowLineLeft,
  ArrowLineRight,
  FloppyDisk,
  Trash,
} from "@phosphor-icons/react"
import type {
  DockviewApi,
  IDockviewPanel,
  SerializedDockview,
} from "dockview-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/responsive-dialog"
import { Input } from "@/components/ui/input"
import type { SidebarSide } from "@/components/layout/use-sidebar-side"
import type { SerializedNode } from "@/components/panes/layout-shapes"
import {
  buildTemplate,
  TEMPLATES,
  type TemplateDef,
} from "@/components/panes/layout-templates"
import {
  WORKSPACE_KINDS,
  type PaneKind,
  type PaneParams,
} from "@/components/panes/pane-kinds"
import type { PaneLayout } from "@/components/panes/use-pane-layout"
import {
  applyLayout,
  gridPanels,
  isDeckCollapsed,
  isDeckEmpty,
} from "@/components/panes/terminal-deck"
import {
  useCustomLayouts,
  type CustomLayout,
} from "@/components/panes/use-custom-layouts"
import { cn } from "@/lib/utils"

interface LayoutsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  layout: PaneLayout
  /** False outside a workspace, where there are no panes to arrange. */
  hasPanes: boolean
  /**
   * Whether the layout belongs to a workspace. A global layout cannot hold a
   * terminal or a Changes pane, so a template is not allowed to open one there —
   * the same rule the zone's `+` menu applies.
   */
  hasWorkspace: boolean
  side: SidebarSide
  onSideChange: (side: SidebarSide) => void
}

/**
 * The layouts picker: four built-in shapes, your saved ones, and which edge the
 * sidebar sits on.
 *
 * Everything here goes through `fromJSON(…, { reuseExistingPanels: true })`, which
 * is what keeps a running terminal running across a switch. Phase 0 measured both
 * paths: with the flag nothing remounts, without it everything does. See the plan's
 * §3.7 — and note that the flag alone is not enough, which is why every shape is
 * built over the *live* pane set rather than shipped as a constant.
 */
export function LayoutsDialog({
  open,
  onOpenChange,
  layout,
  hasPanes,
  hasWorkspace,
  side,
  onSideChange,
}: LayoutsDialogProps) {
  const custom = useCustomLayouts()
  const [name, setName] = useState("")

  /** Apply a serialized layout, preserving every live pane — deck included. */
  const apply = useCallback(
    (next: SerializedDockview | null) => {
      if (!layout.api || !next) return
      applyLayout(layout.api, next)
      onOpenChange(false)
    },
    [layout.api, onOpenChange]
  )

  /**
   * The panes a template would open right now to fill the zones it is drawing.
   *
   * A template is a function of the *live* pane set (see `buildTemplate`), so with
   * a lone chat open — or none, which is what an emptied layout looks like — every
   * shape collapses onto what is there and the picker used to close having done
   * nothing. Picking "Quad" is a request for four zones, so the missing ones get
   * the kinds the template rosters. Kinds already open are skipped, nothing is
   * closed, and the roster is trimmed to the shortfall: with a chat and a terminal
   * up, Quad opens two panes rather than four.
   *
   * A *global* layout is the one case that can still come up short — it cannot hold
   * a terminal or a Changes pane at all (the rule the zone's `+` menu applies), so
   * those are filtered out and the shape stays whatever the live panes can make.
   *
   * Counted over the *grid*: the deck is the shell's bottom edge, so a terminal in
   * it does not fill a zone. A shape that draws the deck asks for a shell of its own
   * — and only when the drawer is empty, because one already down there is the one
   * the band is promising to show.
   */
  const fillsFor = useCallback(
    (template: TemplateDef): PaneKind[] => {
      const api = layout.api
      if (!api) return []
      const allowed = (kind: PaneKind) =>
        hasWorkspace || !WORKSPACE_KINDS.includes(kind)
      const wanted: PaneKind[] =
        template.deck && isDeckEmpty(api) && allowed("terminal") ? ["terminal"] : []

      const panels = gridPanels(api)
      const shortfall = advertisedZones(template) - panels.length
      if (shortfall <= 0) return wanted
      const open = new Set(
        panels.map((panel) => (panel.params as PaneParams | undefined)?.kind)
      )
      return [
        ...wanted,
        ...template.fills
          .filter((kind) => !open.has(kind) && allowed(kind))
          .slice(0, shortfall),
      ]
    },
    [layout.api, hasWorkspace]
  )

  const applyTemplate = useCallback(
    (template: TemplateDef) => {
      const api = layout.api
      if (!api) return
      // Read before opening anything: `openPane` focuses what it adds, and a
      // layout picker should rearrange the window without moving the cursor —
      // the same rule `buildTemplate` follows for the zone it marks active.
      const active = api.activePanel?.api.id
      for (const kind of fillsFor(template)) layout.openPane(kind)
      apply(buildTemplate(template.id, api, active ?? api.activePanel?.api.id))
    },
    [layout, apply, fillsFor]
  )

  /**
   * Applying a *saved* layout.
   *
   * A saved arrangement carries the pane ids of the workspace it was saved in, so
   * replaying it verbatim in another workspace would name panes that do not exist
   * and drop the ones that do. What transfers is the *shape*: how many zones, how
   * they are split. So the geometry is read off the saved layout and the live panes
   * are dealt into it — which is the same thing `buildTemplate` does, one step less
   * opinionated about which pane goes where.
   */
  const applyCustom = useCallback(
    (item: CustomLayout) => {
      if (!layout.api) return
      const panels = gridPanels(layout.api)
      if (panels.length === 0) return
      const zones = countZones(item.layout.grid.root)
      const reshaped = reshape(
        item.layout,
        layout.api,
        panels,
        layout.api.activePanel?.api.id
      )
      if (!reshaped) {
        toast.info(
          `"${item.name}" needs ${zones} panes; open ${zones - panels.length} more to use it.`
        )
        return
      }
      apply(reshaped)
      if (panels.length > zones) {
        // Not a silent cap: a shape with fewer zones than panes tabs the extras
        // together, and saying so is cheaper than letting someone wonder where a
        // pane went.
        toast.info(
          `Applied "${item.name}" — ${zones} ${zones === 1 ? "zone" : "zones"}, so some panes share one.`
        )
      }
    },
    [layout.api, apply]
  )

  /**
   * Why a template would change nothing, or null when it would.
   *
   * Computed per render rather than memoised: the dialog is mounted only while it
   * is open, and this is four pure builds over a handful of panes. In a workspace
   * this is now almost always null — a template that is short on panes opens them
   * rather than reporting the shortfall. What is left is the honestly inert case:
   * the window is already arranged that way.
   */
  const currentShape = layout.api ? shapeKey(layout.api.toJSON()) : null
  const blockedReason = (template: TemplateDef): string | null => {
    const api = layout.api
    if (!api) return "Open a workspace to arrange its panes."
    // Mirrors `applyTemplate`: one about to open panes changes something by
    // definition. Only once it has them is it judged on its shape.
    if (fillsFor(template).length > 0) return null
    // And a shape that shows the deck changes the window whenever the drawer is
    // shut, whatever the grid above it already looks like.
    if (template.deck && isDeckCollapsed(api)) return null
    const next = buildTemplate(template.id, api, api.activePanel?.api.id)
    if (!next) return "Open a pane to arrange."
    if (shapeKey(next) !== currentShape) return null
    return countZones(next.grid.root) < advertisedZones(template)
      ? `"${template.label}" needs another pane — open one and it will have somewhere to put it.`
      : `The panes are already arranged like "${template.label}".`
  }

  const saveCurrent = useCallback(() => {
    if (!layout.api) return
    custom.save(name || `Layout ${custom.items.length + 1}`, layout.api.toJSON())
    setName("")
    toast.success("Arrangement saved")
  }, [layout.api, custom, name])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Layouts</DialogTitle>
          <DialogDescription>
            Rearrange the zones, opening any pane a layout is short of. Nothing
            closes and nothing restarts — a terminal does not lose its shell.
          </DialogDescription>
        </DialogHeader>

        {!hasPanes ? (
          <p className="text-sm text-muted-foreground">
            Open a workspace to arrange its panes.
          </p>
        ) : (
          <>
            <section className="space-y-2">
              <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Templates
              </h3>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {TEMPLATES.map((template) => {
                  const blocked = blockedReason(template)
                  // Dimmed but not `disabled`, and deliberately not
                  // `aria-disabled` either: a button that cannot be clicked cannot
                  // tell you why it did nothing, which is the whole complaint. It
                  // stays actionable and answers instead.
                  return (
                    <button
                      key={template.id}
                      type="button"
                      onClick={() =>
                        blocked ? toast.info(blocked) : applyTemplate(template)
                      }
                      title={blocked ?? template.description}
                      className={cn(
                        "flex flex-col gap-2 rounded-lg border border-border p-2 text-left hover:border-primary/50 hover:bg-accent",
                        blocked && "opacity-50"
                      )}
                    >
                      <Schematic rows={template.preview} />
                      <span className="truncate text-xs font-medium text-foreground">
                        {template.label}
                      </span>
                    </button>
                  )
                })}
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Saved
              </h3>
              {custom.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Arrange the panes how you like, then save it below.
                </p>
              ) : (
                <ul className="divide-y divide-border/60">
                  {custom.items.map((item) => (
                    <li key={item.id} className="flex items-center gap-2 py-1.5">
                      <button
                        type="button"
                        onClick={() => applyCustom(item)}
                        className="min-w-0 flex-1 truncate rounded-md px-2 py-1 text-left text-sm text-foreground hover:bg-accent"
                      >
                        {item.name}
                      </button>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {countZones(item.layout.grid.root)} zones
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => custom.remove(item.id)}
                        aria-label={`Delete ${item.name}`}
                        className="size-7 text-muted-foreground hover:text-destructive"
                      >
                        <Trash className="size-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex items-center gap-2">
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") saveCurrent()
                  }}
                  placeholder="Name this arrangement"
                  className="h-8 text-sm"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={saveCurrent}
                  className="shrink-0 gap-1.5"
                >
                  <FloppyDisk className="size-4" />
                  Save current
                </Button>
              </div>
            </section>
          </>
        )}

        <section className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Sidebar
          </h3>
          <div className="flex gap-2">
            {(["left", "right"] as SidebarSide[]).map((option) => {
              const Icon = option === "left" ? ArrowLineLeft : ArrowLineRight
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => onSideChange(option)}
                  aria-pressed={side === option}
                  className={cn(
                    "flex flex-1 items-center justify-center gap-2 rounded-lg border p-2 text-sm capitalize",
                    side === option
                      ? "border-primary/60 bg-accent text-foreground"
                      : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
                  )}
                >
                  <Icon className="size-4" />
                  {option}
                </button>
              )
            })}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  )
}

/**
 * How many *grid* zones a template's schematic advertises.
 *
 * Read off the picture rather than declared twice: the schematic is what the user is
 * promised, so it is also the right thing to measure a shortfall against. Minus the
 * deck's band, which is drawn in the same picture but is the shell's bottom edge
 * rather than a zone the grid has to find a pane for.
 */
const advertisedZones = (template: TemplateDef) =>
  template.preview.reduce((sum, row) => sum + row.columns.length, 0) -
  (template.deck ? 1 : 0)

/**
 * A layout's arrangement, with everything that is not the arrangement removed.
 *
 * Zone ids and pixel sizes are not part of what a user sees as "the same window",
 * so they are dropped; the nesting is kept, because a column split in two and two
 * zones side by side hold the same panes in the same order and are not the same
 * layout. Orientation only counts once there is a split — a single zone is the
 * whole window whichever axis it claims, which is why the deck reads as a no-op
 * with one pane open rather than as a change.
 */
function shapeKey(layout: SerializedDockview): string {
  const walk = (node: SerializedNode): unknown =>
    node.type === "leaf"
      ? (node.data as { views: string[] }).views
      : (node.data as SerializedNode[]).map(walk)
  const axis = countZones(layout.grid.root) > 1 ? layout.grid.orientation : ""
  return JSON.stringify([axis, walk(layout.grid.root as SerializedNode)])
}

/** How many leaf zones a serialized grid has. */
function countZones(node: unknown): number {
  const typed = node as { type: string; data: unknown }
  if (typed.type === "leaf") return 1
  return (typed.data as unknown[]).reduce<number>(
    (sum, child) => sum + countZones(child),
    0
  )
}

/**
 * Re-deal the live panes into a saved layout's geometry.
 *
 * Walks the saved tree in order, replacing each zone's view list with a slice of
 * the live panes, and takes `panels` and the deck from the **live** layout rather
 * than the saved one. The saved map is keyed by the pane ids of the workspace it
 * came from; reusing it would hand `fromJSON` a layout whose views name panels it has
 * no state for, and whose real panels are absent and therefore destroyed. That is the
 * §3.7 failure mode wearing a different hat — and the deck's shells are the sharpest
 * case of it, since they are named nowhere in the grid at all.
 *
 * `panels` is the *grid's* panes, for the same reason a template arranges only those:
 * a saved shape is a shape for the grid, and the deck stays as the user left it.
 *
 * Extra panes join the last zone rather than being dropped. A shape with *more*
 * zones than panes is refused outright, because an empty zone is not a legal
 * layout.
 */
function reshape(
  saved: SerializedDockview,
  api: DockviewApi,
  panels: IDockviewPanel[],
  activePanelId?: string
): SerializedDockview | null {
  if (panels.length === 0) return null
  const zones = countZones(saved.grid.root)
  if (panels.length < zones) return null

  const paneIds = panels.map((panel) => panel.api.id)
  const groups: string[][] = Array.from({ length: zones }, () => [])
  paneIds.forEach((id, index) => groups[Math.min(index, zones - 1)].push(id))

  let cursor = 0
  let activeGroup: string | undefined
  const walk = (node: SerializedNode): SerializedNode => {
    if (node.type === "leaf") {
      const views = groups[cursor] ?? []
      const data = node.data as { id: string }
      cursor += 1
      if (activePanelId && views.includes(activePanelId)) activeGroup = data.id
      return { ...node, data: { ...data, views, activeView: views[0] } }
    }
    return { ...node, data: (node.data as SerializedNode[]).map(walk) }
  }

  const root = walk(saved.grid.root as SerializedNode)
  const live = api.toJSON()

  return {
    ...saved,
    grid: { ...saved.grid, root },
    // Every live pane, deck included: the grid names only the ones dealt above, and
    // anything missing from here is a pane `fromJSON` destroys.
    panels: live.panels,
    // The deck as it is now, not as it was when this arrangement was saved — same
    // reason. Its serialized state names the pane ids of another workspace.
    edgeGroups: live.edgeGroups,
    activeGroup,
    // Dropped: a saved layout's floating and popout groups. They reference the same
    // stale ids, and we do not ship popouts (open question 7 deferred them).
    floatingGroups: undefined,
    popoutGroups: undefined,
  }
}

/** The little zone diagram on a template button. */
function Schematic({ rows }: { rows: TemplateDef["preview"] }) {
  return (
    <span
      aria-hidden
      className="flex h-10 w-full flex-col gap-0.5 overflow-hidden rounded border border-border/60 bg-muted/40 p-0.5"
    >
      {rows.map((row, rowIndex) => (
        <span
          key={rowIndex}
          style={{ flexGrow: row.weight }}
          className="flex gap-0.5"
        >
          {row.columns.map((weight, columnIndex) => (
            <span
              key={columnIndex}
              style={{ flexGrow: weight }}
              className="rounded-sm bg-muted-foreground/30"
            />
          ))}
        </span>
      ))}
    </span>
  )
}
