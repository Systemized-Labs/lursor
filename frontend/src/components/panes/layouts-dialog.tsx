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
import {
  asLeaf,
  children,
  countLeaves,
  leafViews,
  leaves,
  mapLeaves,
  type SerializedNode,
} from "@/components/panes/layout-shapes"
import {
  buildTemplate,
  gridZones,
  TEMPLATES,
  type TemplateDef,
} from "@/components/panes/layout-templates"
import {
  isPaneKind,
  paneKindOf,
  WORKSPACE_KINDS,
  type PaneKind,
  type PaneParams,
} from "@/components/panes/pane-kinds"
import type { PaneLayout } from "@/components/panes/use-pane-layout"
import {
  applyLayout,
  bottomPaneIds,
  bottomRowId,
  expandBottomPanel,
  gridPanes,
  hasBottomPanel,
  isBottomCollapsed,
  savedBottomViews,
} from "@/components/panes/bottom-panel"
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
   * the same rule the zone's `+` menu applies, and the reason a global layout never grows
   * a bottom row: the only pane a shape puts down there is a shell.
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
 * built over the *live* pane set rather than shipped as a constant. The bottom panel is a
 * row of that grid, so the flag covers its shells too and there is nothing to carry by
 * hand.
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

  /** Apply a serialized layout, preserving every live pane — the bottom row's included. */
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
   * nothing. Picking "Workbench" is a request for its two zones and a panel below, so the
   * missing ones get the kinds the template rosters. Kinds already open are skipped,
   * nothing is closed, and the roster is trimmed to the shortfall: with a chat
   * already up, Workbench opens a Preview and a shell rather than three panes.
   *
   * A *global* layout is the one case that can still come up short — it cannot hold
   * a terminal or a Changes pane at all (the rule the zone's `+` menu applies), so
   * those are filtered out and the shape stays whatever the live panes can make.
   *
   * Counted over the zones the roster fills, and their panes are all this returns. The
   * bottom row's own shell is {@link needsBottomShell}, requested separately, because it
   * goes at the bottom rather than in whichever zone the roster is up to.
   */
  const fillsFor = useCallback(
    (template: TemplateDef): PaneKind[] => {
      const api = layout.api
      if (!api) return []
      const panels = gridPanes(api)
      const shortfall = gridZones(template) - panels.length
      if (shortfall <= 0) return []
      const open = new Set(panels.map(paneKindOf))
      return template.fills
        .filter(
          (kind) =>
            !open.has(kind) &&
            (hasWorkspace || !WORKSPACE_KINDS.includes(kind))
        )
        .slice(0, shortfall)
    },
    [layout.api, hasWorkspace]
  )

  /**
   * Whether this shape has to open a shell in the bottom row.
   *
   * Only when there is no bottom row: one already down there is what the band is promising
   * to show, and a second pane nobody asked for is not an improvement. A *global* layout
   * never does — no workspace, so no directory for a shell to run in.
   */
  const needsBottomShell = useCallback(
    (template: TemplateDef): boolean =>
      Boolean(template.bottom) &&
      hasWorkspace &&
      layout.api !== null &&
      !hasBottomPanel(layout.api),
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
      if (needsBottomShell(template)) {
        layout.openPane("terminal", { target: "bottom" })
      }
      for (const kind of fillsFor(template)) layout.openPane(kind)
      apply(buildTemplate(template.id, api, active ?? api.activePanel?.api.id))
      // The shape decides whether the bottom panel is *expanded*, never whether it exists:
      // the tree carries whatever is down there either way (see `buildTemplate`), and a
      // collapsed panel that a shape draws should come out.
      if (template.bottom) expandBottomPanel(api)
    },
    [layout, apply, fillsFor, needsBottomShell]
  )

  /**
   * The panes a saved arrangement is short of, in the kinds it was saved with.
   *
   * `fillsFor`'s counterpart, working from better information: a template rosters its
   * kinds by hand, while a saved arrangement's own panel map records exactly what was
   * open when it was saved. So a shortfall is filled with the arrangement's own panes
   * rather than a guess — in the arrangement's own layout order, so the zone that held
   * a chat gets a chat.
   *
   * Zone panes only, like `fillsFor` — the bottom row's shell is
   * {@link savedNeedsBottomShell}, and its zone is subtracted here for the same reason
   * `gridZones` subtracts the band from a template's schematic.
   */
  const restoreFills = useCallback(
    (saved: SerializedDockview): PaneKind[] => {
      const api = layout.api
      if (!api) return []
      const allowed = (kind: PaneKind) =>
        hasWorkspace || !WORKSPACE_KINDS.includes(kind)

      const panels = gridPanes(api)
      const shortfall = savedGridZones(saved) - panels.length
      if (shortfall <= 0) return []

      const open = new Set(panels.map(paneKindOf))
      const missing: PaneKind[] = []
      for (const id of leafViews(saved.grid.root).flat()) {
        const kind = (saved.panels?.[id] as { params?: PaneParams } | undefined)
          ?.params?.kind
        if (!isPaneKind(kind)) continue
        if (open.has(kind) || missing.includes(kind) || !allowed(kind)) continue
        missing.push(kind)
      }
      return missing.slice(0, shortfall)
    },
    [layout.api, hasWorkspace]
  )

  /**
   * Whether a saved arrangement has to open a shell in the bottom row.
   *
   * {@link needsBottomShell} for saved layouts: the arrangement had a bottom row and there
   * is none now. The saved roster's *ids* are another workspace's, but whether it had one at
   * all is transferable — see `savedBottomViews`.
   */
  const savedNeedsBottomShell = useCallback(
    (saved: SerializedDockview): boolean =>
      savedBottomViews(saved).length > 0 &&
      hasWorkspace &&
      layout.api !== null &&
      !hasBottomPanel(layout.api),
    [layout.api, hasWorkspace]
  )

  /**
   * Applying a *saved* layout.
   *
   * A saved arrangement carries the pane ids of the workspace it was saved in, so
   * replaying it verbatim in another workspace would name panes that do not exist
   * and drop the ones that do. So it is applied as a shape re-derived over the live
   * pane set — the same thing `applyTemplate` does, including opening the panes the
   * shape is short of. Refusing with "open two more first" made restoring your own
   * arrangement the one thing in this dialog that did not simply work.
   */
  const applyCustom = useCallback(
    (item: CustomLayout) => {
      const api = layout.api
      if (!api) return
      const zones = countLeaves(item.layout.grid.root)
      // Read before opening anything, for the same reason `applyTemplate` does:
      // `openPane` focuses what it adds, and restoring a layout should not move the
      // cursor off the pane you were in.
      const active = api.activePanel?.api.id
      if (savedNeedsBottomShell(item.layout)) {
        layout.openPane("terminal", { target: "bottom" })
      }
      for (const kind of restoreFills(item.layout)) layout.openPane(kind)

      const panels = api.panels
      const reshaped = reshape(item.layout, api, panels, active)
      if (!reshaped) {
        // Only reachable where a pane cannot be opened to close the gap: a global
        // layout, whose kinds are filtered out of the fills above, or an arrangement
        // saved over an empty grid before `saveCurrent` started refusing those.
        toast.info(
          zones === 0
            ? `"${item.name}" was saved with no panes in it — there is no arrangement to restore.`
            : panels.length === 0
              ? `"${item.name}" needs a pane to arrange — open one first.`
              : `"${item.name}" needs ${zones} panes; open ${zones - panels.length} more to use it.`
        )
        return
      }
      apply(reshaped)
      // The bottom row is drawn by the arrangement, so it comes back as the row it was
      // saved as — but *collapsed* is our own flag, and it belongs to the workspace rather
      // than to the arrangement. Restoring one that has panes in it expands it, for the
      // reason `expandBottomPanel` exists at all: a pane nobody can see reads as a pane
      // that was lost.
      if (savedBottomViews(reshaped).length > 0) expandBottomPanel(api)
      if (panels.length > zones) {
        // Not a silent cap: a shape with fewer zones than panes tabs the extras
        // together, and saying so is cheaper than letting someone wonder where a
        // pane went.
        toast.info(
          `Applied "${item.name}" — it has fewer zones than you have panes, so some share a zone.`
        )
      }
    },
    [layout, apply, restoreFills, savedNeedsBottomShell]
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
    // Mirrors `applyTemplate`, both halves: one about to open panes — in the grid or
    // at the bottom — changes something by definition. Only once it has them is it
    // judged on its shape.
    if (fillsFor(template).length > 0 || needsBottomShell(template)) return null
    // And a shape that draws a bottom row changes the window whenever that row is
    // collapsed, whatever the zones above it already look like.
    if (template.bottom && isBottomCollapsed(api)) return null
    const next = buildTemplate(template.id, api, api.activePanel?.api.id)
    if (!next) return "Open a pane to arrange."
    if (shapeKey(next) !== currentShape) return null
    return countLeaves(next.grid.root) < gridZones(template)
      ? `"${template.label}" needs another pane — open one and it will have somewhere to put it.`
      : `The panes are already arranged like "${template.label}".`
  }

  const saveCurrent = useCallback(() => {
    if (!layout.api) return
    // `hasPanes` is true anywhere the pane layer is mounted, which is not the same as
    // the grid having something in it — the empty-state cards are a legal state, and
    // an arrangement of no zones is one nothing can ever be restored into.
    if (gridPanes(layout.api).length === 0) {
      toast.info("Open a pane first — there is no arrangement to save yet.")
      return
    }
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
                        {countLeaves(item.layout.grid.root) === 1
                          ? "1 zone"
                          : `${countLeaves(item.layout.grid.root)} zones`}
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
 * A layout's arrangement, with everything that is not the arrangement removed.
 *
 * Zone ids and pixel sizes are not part of what a user sees as "the same window",
 * so they are dropped; the nesting is kept, because a column split in two and two
 * zones side by side hold the same panes in the same order and are not the same
 * layout. Orientation only counts once there is a split — a single zone is the
 * whole window whichever axis it claims.
 */
function shapeKey(layout: SerializedDockview): string {
  const walk = (node: SerializedNode): unknown =>
    asLeaf(node)?.views ?? children(node).map(walk)
  const axis = countLeaves(layout.grid.root) > 1 ? layout.grid.orientation : ""
  return JSON.stringify([axis, walk(layout.grid.root)])
}

/**
 * How many zones of a saved arrangement take a pane off the fills roster.
 *
 * `gridZones`' counterpart for a saved layout, and the same subtraction: `countLeaves`
 * counts the regions a user sees, which is the right number for the label on the row and
 * the wrong one for "how many panes does this need" — the bottom row's is a shell, opened
 * by {@link savedNeedsBottomShell} rather than dealt from the roster.
 */
function savedGridZones(saved: SerializedDockview): number {
  return (
    countLeaves(saved.grid.root) - (savedBottomViews(saved).length > 0 ? 1 : 0)
  )
}

/**
 * Re-deal the live panes into a saved layout's geometry.
 *
 * `panels` and the panel *map* come from the **live** layout, never the saved one.
 * The saved map is keyed by the pane ids of the workspace it came from; reusing it
 * would hand `fromJSON` a layout whose views name panels it has no state for, and whose
 * real panels are absent and therefore destroyed. That is the §3.7 failure mode wearing
 * a different hat.
 *
 * But the saved *rosters* are honoured wherever their ids are still live, which is the
 * common case: an arrangement saved in this workspace names the very panes in front of
 * you. Dealing by position instead — which is what this used to do — meant restoring
 * your own arrangement put whichever pane dockview happened to register first into the
 * zone you had kept for a chat. The shape came back and the contents did not, which is
 * the half of "restore" nobody notices is missing until it moves their chat.
 *
 * `panels` is **every** live pane, the bottom row's included, because that row is a zone of
 * the tree being filled like any other. Its roster is not dealt positionally, though: the
 * live bottom row's own panes are pinned to it up front, so restoring an arrangement cannot
 * promote a shell into a column or park a chat under one. Whatever is down there stays down
 * there.
 *
 * Panes the arrangement never saw fill any zone its own roster left empty, then join
 * the last zone. A shape with *more* zones than panes is refused outright, because an
 * empty zone is not a legal layout.
 */
function reshape(
  saved: SerializedDockview,
  api: DockviewApi,
  panels: IDockviewPanel[],
  activePanelId?: string
): SerializedDockview | null {
  if (panels.length === 0) return null
  const zones = countLeaves(saved.grid.root)
  // A zero-zone arrangement is one saved over an empty grid. There is no shape to
  // restore, and dealing panes into no zones used to walk off the end of the roster
  // list and throw — which the dialog swallowed, so the saved entry simply did
  // nothing when clicked. `saveCurrent` refuses to make new ones; this covers those
  // already in storage.
  if (zones === 0) return null
  if (panels.length < zones) return null

  const paneIds = panels.map((panel) => panel.api.id)
  const liveIds = new Set(paneIds)
  // The arrangement's bottom row is filled from the live one rather than from the saved
  // roster, whose ids may belong to another workspace entirely — whatever is at the bottom
  // now stays at the bottom. Every other zone honours what it was saved with, wherever
  // those ids are still live.
  const savedBottom = bottomRowId(saved.grid)
  const atBottom = bottomPaneIds(api)
  const rosters = leaves(saved.grid.root).map((zone) =>
    zone.id === savedBottom && atBottom.length > 0
      ? [...atBottom]
      : zone.views.filter((id) => liveIds.has(id) && !atBottom.includes(id))
  )
  const claimed = new Set(rosters.flat())
  // Panes the arrangement has no opinion about: opened since it was saved, or — when
  // it came from another workspace, where none of its ids resolve — every pane there is.
  const spare = paneIds.filter((id) => !claimed.has(id))

  // Every zone needs at least one pane. A spare if there is one, else borrowed from
  // whichever zone has the most to give, so a lopsided restore still lands a legal
  // layout rather than being refused with enough panes open to satisfy it.
  const take = (): string | undefined => {
    const next = spare.shift()
    if (next) return next
    const donor = rosters.reduce((most, r) => (r.length > most.length ? r : most))
    return donor.length > 1 ? donor.pop() : undefined
  }
  for (const roster of rosters) {
    if (roster.length === 0) {
      const id = take()
      if (id) roster.push(id)
    }
  }
  if (rosters.some((roster) => roster.length === 0)) return null
  if (spare.length > 0) rosters[rosters.length - 1].push(...spare)

  // Dealt positionally, in the same order `rosters` was built in — `mapLeaves` and
  // `leafViews` share one traversal, which is what makes the cursor line up.
  let cursor = 0
  let activeGroup: string | undefined
  const root = mapLeaves(saved.grid.root, (zone) => {
    const views = rosters[cursor] ?? []
    cursor += 1
    if (activePanelId && views.includes(activePanelId)) activeGroup = zone.id
    return {
      ...zone,
      views,
      // The tab the arrangement was left on, when it is still one of them.
      activeView:
        zone.activeView && views.includes(zone.activeView)
          ? zone.activeView
          : views[0],
    }
  })
  const live = api.toJSON()

  return {
    ...saved,
    grid: { ...saved.grid, root },
    // Every live pane: the grid names only the ones dealt above, and anything missing
    // from here is a pane `fromJSON` destroys.
    panels: live.panels,
    // Never the saved layout's edge group. An arrangement saved before the bottom row moved
    // into the grid still carries one, and handing that back to dockview would have it build
    // the edge group again — the migration on read strips it, and this is the other door
    // into `fromJSON`.
    edgeGroups: undefined,
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
