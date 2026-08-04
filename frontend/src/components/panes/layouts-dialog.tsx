import { useCallback, useState } from "react"
import {
  ArrowLineLeft,
  ArrowLineRight,
  FloppyDisk,
  Trash,
} from "@phosphor-icons/react"
import type { IDockviewPanel, SerializedDockview } from "dockview-react"
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
  panelState,
  type SerializedNode,
} from "@/components/panes/layout-shapes"
import {
  buildTemplate,
  TEMPLATES,
  type TemplateDef,
  type TemplateId,
} from "@/components/panes/layout-templates"
import type { PaneParams } from "@/components/panes/pane-kinds"
import type { PaneLayout } from "@/components/panes/use-pane-layout"
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
  side,
  onSideChange,
}: LayoutsDialogProps) {
  const custom = useCustomLayouts()
  const [name, setName] = useState("")

  /** Apply a serialized layout, preserving every live pane. */
  const apply = useCallback(
    (next: SerializedDockview | null) => {
      if (!layout.api || !next) return
      layout.api.fromJSON(next, { reuseExistingPanels: true })
      onOpenChange(false)
    },
    [layout.api, onOpenChange]
  )

  const applyTemplate = useCallback(
    (id: TemplateId) => {
      if (!layout.api) return
      apply(
        buildTemplate(
          id,
          layout.api.panels,
          layout.api.activePanel?.api.id
        )
      )
    },
    [layout.api, apply]
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
      const panels = layout.api.panels
      if (panels.length === 0) return
      const zones = countZones(item.layout.grid.root)
      const reshaped = reshape(
        item.layout,
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
            Rearrange the zones. Every pane stays open and keeps running — a
            terminal does not lose its shell.
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
                {TEMPLATES.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => applyTemplate(template.id)}
                    title={template.description}
                    className="flex flex-col gap-2 rounded-lg border border-border p-2 text-left hover:border-primary/50 hover:bg-accent"
                  >
                    <Schematic rows={template.preview} />
                    <span className="truncate text-xs font-medium text-foreground">
                      {template.label}
                    </span>
                  </button>
                ))}
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
 * the live panes, and rebuilds the `panels` map from those panes — **not** from the
 * saved one. The saved map is keyed by the pane ids of the workspace it came from;
 * reusing it would hand `fromJSON` a layout whose views name panels it has no state
 * for, and whose real panels are absent and therefore destroyed. That is the §3.7
 * failure mode wearing a different hat.
 *
 * Extra panes join the last zone rather than being dropped. A shape with *more*
 * zones than panes is refused outright, because an empty zone is not a legal
 * layout.
 */
function reshape(
  saved: SerializedDockview,
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

  return {
    ...saved,
    grid: { ...saved.grid, root },
    panels: Object.fromEntries(
      panels.map((panel) => [
        panel.api.id,
        panelState(panel.api.id, panel.params as PaneParams),
      ])
    ),
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
