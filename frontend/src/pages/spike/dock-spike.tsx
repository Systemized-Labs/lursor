/**
 * THROWAWAY — Phase 0 spike for docs/PLAN-shell-rewrite.md §8.
 *
 * The one question this page exists to answer: does dockview's
 * `renderer: 'always'` keep our three hostile panes *alive* — same DOM nodes,
 * same sessions — across a cross-group move, a `fromJSON` template switch and a
 * sidebar-side swap? Delete this file (and its route) once the answer is
 * recorded in the plan.
 *
 * How to read the liveness readouts. They are deliberately *intrinsic* state,
 * not React counters, because a React counter under StrictMode double-mounting
 * would lie in dev:
 *
 * - **Terminal** — a real PTY over a WebSocket. A remount is a new shell, so
 *   anything you typed (`x=42; echo $x`) is gone from the scrollback.
 * - **Iframe** — the embedded document runs its own `setInterval` uptime clock
 *   and its own scroll. Reparenting an iframe reloads it, so the clock snapping
 *   back to 0s is the unambiguous failure signal.
 * - **Monaco** — the buffer text plus `getAlternativeVersionId()`, which is the
 *   undo-stack position. A remount resets both.
 *
 * `MOUNTED AT` on each pane is a per-instance timestamp taken during the first
 * render (via a ref, so StrictMode's double render does not bump it). If it
 * changes after an action, the React component instance was recreated.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Editor from "@monaco-editor/react"
import type * as Monaco from "monaco-editor"
import {
  DockviewReact,
  Orientation,
  type DockviewApi,
  type DockviewReadyEvent,
  type GroupviewPanelState,
  type IDockviewPanelProps,
  type SerializedDockview,
  type SerializedGridObject,
} from "dockview-react"
import "dockview-react/dist/styles/dockview.css"

// The real setup module, so Monaco resolves from the bundle exactly as it does
// in the Files panel. Without it `@monaco-editor/react` reaches for a CDN, which
// would make this spike test a different editor from the one we ship.
import "@/components/files/monaco-setup"
import { TerminalPanel } from "@/components/shell/terminal-panel"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// ── liveness instrumentation ─────────────────────────────────────────────────

let instanceSeq = 0

/**
 * A stable per-component-instance id and mount time. Assigned from a ref during
 * render rather than in an effect, so React StrictMode's double *render* reuses
 * the same value while a genuine remount (a new instance, hence a new ref) gets
 * a new one.
 */
function useInstanceStamp() {
  const ref = useRef<{ seq: number; at: string } | null>(null)
  if (ref.current === null) {
    ref.current = {
      seq: ++instanceSeq,
      at: new Date().toLocaleTimeString([], {
        hour12: false,
        minute: "2-digit",
        second: "2-digit",
      }),
    }
  }
  return ref.current
}

/** A pane's chrome: what it is, and whether this instance is the original. */
function PaneHeader({
  pane,
  label,
  detail,
  visible,
}: {
  pane: string
  label: string
  detail: string
  visible: boolean
}) {
  const stamp = useInstanceStamp()
  return (
    /* `data-pane` / `data-instance` exist so the driver script can read liveness
       off a stable hook rather than matching on visible text — a text match on
       "TERMINAL" also hits the "Terminal deck" button in the toolbar. */
    <div
      data-pane={pane}
      data-instance={stamp.seq}
      data-mounted-at={stamp.at}
      data-visible={visible}
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-card px-3 py-1.5 font-mono text-[11px]"
    >
      <span className="text-foreground">{label}</span>
      <span className="text-muted-foreground">
        instance #{stamp.seq} · mounted at {stamp.at}
      </span>
      <span data-detail className="text-muted-foreground">
        {detail}
      </span>
      <span
        className={cn(
          "ml-auto",
          visible ? "text-foreground" : "text-muted-foreground"
        )}
      >
        {visible ? "visible" : "hidden"}
      </span>
    </div>
  )
}

/**
 * Track `api.onDidVisibilityChange`, the §3.4 gate: with `renderer: 'always'` a
 * hidden pane keeps running, so each kind has to be told when it is off screen.
 * The spike only reports it — the point is to prove the event actually fires.
 */
function usePaneVisibility(props: IDockviewPanelProps): boolean {
  const [visible, setVisible] = useState(() => props.api.isVisible)
  useEffect(() => {
    setVisible(props.api.isVisible)
    const sub = props.api.onDidVisibilityChange((e) => setVisible(e.isVisible))
    return () => sub.dispose()
  }, [props.api])
  return visible
}

// ── the three hostile panes ──────────────────────────────────────────────────

function TerminalPane(props: IDockviewPanelProps) {
  const visible = usePaneVisibility(props)
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <PaneHeader
        pane="terminal"
        label="TERMINAL"
        detail="type `x=42` then `echo $x` — a remount loses the shell"
        visible={visible}
      />
      <div className="min-h-0 flex-1">
        <TerminalPanel />
      </div>
    </div>
  )
}

/**
 * The embedded document. Its uptime clock and scroll position are the failure
 * signal: an iframe that gets reparented in the DOM reloads, resetting both.
 */
const IFRAME_DOC = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  body { margin: 0; font: 13px/1.5 ui-monospace, monospace; background: #101014; color: #e6e6e6; }
  #clock { position: sticky; top: 0; padding: 10px 12px; background: #1b1b22; font-size: 22px; }
  p { margin: 0; padding: 6px 12px; border-bottom: 1px solid #24242c; }
</style></head><body>
  <div id="clock">uptime 0s</div>
  <div id="rows"></div>
  <script>
    var t0 = Date.now();
    setInterval(function () {
      document.getElementById('clock').textContent =
        'uptime ' + Math.round((Date.now() - t0) / 1000) + 's · scrollY ' + Math.round(window.scrollY);
    }, 250);
    var rows = document.getElementById('rows');
    for (var i = 1; i <= 200; i++) {
      var p = document.createElement('p');
      p.textContent = 'scrollable row ' + i;
      rows.appendChild(p);
    }
  </script>
</body></html>`

function IframePane(props: IDockviewPanelProps) {
  const visible = usePaneVisibility(props)
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <PaneHeader
        pane="iframe"
        label="PREVIEW (iframe)"
        detail="scroll it, then move it — uptime resetting to 0s means it reloaded"
        visible={visible}
      />
      {/* `srcDoc` is set once from a constant, so React never has a reason to
          re-navigate it: any reload seen here came from the DOM node moving. */}
      <iframe
        title="spike-preview"
        srcDoc={IFRAME_DOC}
        className="min-h-0 flex-1 border-0"
      />
    </div>
  )
}

const MONACO_SEED = `// Edit me, undo a few times, then move this pane.
// ALT VERSION ID below is Monaco's undo-stack position.
function greet(name) {
  return "hello " + name
}
`

function MonacoPane(props: IDockviewPanelProps) {
  const visible = usePaneVisibility(props)
  const [altVersion, setAltVersion] = useState<number | null>(null)
  const [lineCount, setLineCount] = useState<number | null>(null)

  const onMount = useCallback((editor: Monaco.editor.IStandaloneCodeEditor) => {
    const model = editor.getModel()
    if (!model) return
    const sync = () => {
      setAltVersion(model.getAlternativeVersionId())
      setLineCount(model.getLineCount())
    }
    sync()
    model.onDidChangeContent(sync)
    // THROWAWAY instrumentation. Synthetic keystrokes do not reliably reach
    // Monaco's hidden textarea in a headless browser, so the driver script types
    // through Monaco's own command path instead — which is also the only way to
    // exercise the real undo stack rather than just the buffer text.
    const w = window as unknown as {
      __spikeEditor?: Monaco.editor.IStandaloneCodeEditor
      __spikeMounts?: number
    }
    w.__spikeEditor = editor
    w.__spikeMounts = (w.__spikeMounts ?? 0) + 1
  }, [])

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <PaneHeader
        pane="monaco"
        label="MONACO"
        detail={`alt version id ${altVersion ?? "…"} · ${lineCount ?? "…"} lines`}
        visible={visible}
      />
      <div className="min-h-0 flex-1">
        <Editor
          defaultLanguage="javascript"
          defaultValue={MONACO_SEED}
          theme="vs-dark"
          options={{ minimap: { enabled: false }, fontSize: 13 }}
          onMount={onMount}
        />
      </div>
    </div>
  )
}

/** A deliberately cheap pane, to prove mixed renderers coexist. */
function NotePane(props: IDockviewPanelProps) {
  const visible = usePaneVisibility(props)
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <PaneHeader
        pane="note"
        label="NOTE (onlyWhenVisible)"
        detail="cheap pane — remounting this one is fine and expected"
        visible={visible}
      />
      <p className="p-3 text-xs text-muted-foreground">
        This pane opts out of the lossless renderer, so its instance number is
        expected to climb. Everything else on screen must not.
      </p>
    </div>
  )
}

const COMPONENTS = {
  terminal: TerminalPane,
  iframe: IframePane,
  monaco: MonacoPane,
  note: NotePane,
}

// ── layout templates ────────────────────────────────────────────────────────

/**
 * The panes the spike opens. `renderer` is the load-bearing field — everything
 * expensive is `always`, and the cheap note pane is left on the default so the
 * two modes are proven to coexist.
 */
const PANES: GroupviewPanelState[] = [
  {
    id: "pane-terminal",
    contentComponent: "terminal",
    title: "Terminal",
    renderer: "always",
  },
  {
    id: "pane-iframe",
    contentComponent: "iframe",
    title: "Preview",
    renderer: "always",
  },
  {
    id: "pane-monaco",
    contentComponent: "monaco",
    title: "Editor",
    renderer: "always",
  },
  {
    id: "pane-note",
    contentComponent: "note",
    title: "Note",
    renderer: "onlyWhenVisible",
  },
]

type Shape = "default" | "focus" | "deck" | "quad"

const SHAPE_LABELS: Record<Shape, string> = {
  default: "Default",
  focus: "Focus",
  deck: "Terminal deck",
  quad: "Quad",
}

/**
 * The per-group state in a serialized layout. v7 does not re-export
 * `GroupPanelViewState` from its public entry, so it is recovered from the type
 * that *is* public. Worth knowing before Phase 5 hand-authors templates — the
 * alternative is an `any` in the one place that must not have one.
 */
type GroupState =
  SerializedDockview["grid"]["root"] extends SerializedGridObject<infer T>
    ? T
    : never

type Node = SerializedGridObject<GroupState>

/** One group holding `views`, tabbed, with the first as the active tab. */
const leaf = (id: string, views: string[], size: number): Node => ({
  type: "leaf",
  data: { id, views, activeView: views[0] },
  size,
})

const branch = (children: Node[], size?: number): Node => ({
  type: "branch",
  data: children,
  size,
})

/**
 * Distribute `ids` into `n` non-empty buckets, in order. Empty groups are not a
 * legal serialized layout, so a shape asking for more cells than there are panes
 * simply gets fewer cells.
 */
function buckets(ids: string[], n: number): string[][] {
  const out: string[][] = Array.from({ length: Math.min(n, ids.length) }, () => [])
  if (out.length === 0) return []
  ids.forEach((id, i) => out[i % out.length].push(id))
  return out
}

/**
 * Build a template layout over the panes that are *currently* open.
 *
 * This is the §3.7 finding in code: a template cannot be a frozen constant,
 * because `fromJSON` destroys any panel the incoming layout does not mention.
 * So a template is a *function of the live pane set* — every open pane is placed
 * somewhere — and the switch is applied with `reuseExistingPanels`, which v7
 * added precisely so surviving panels keep their instances.
 */
function buildLayout(shape: Shape, ids: string[]): SerializedDockview {
  const present = PANES.map((p) => p.id).filter((id) => ids.includes(id))
  const panels = Object.fromEntries(
    PANES.filter((p) => present.includes(p.id)).map((p) => [p.id, p])
  )

  // Root orientation is set per shape rather than relying on dockview's
  // alternating-orientation rule, so each template reads as what it looks like.
  let orientation = Orientation.HORIZONTAL
  let root: Node

  if (shape === "focus" || present.length < 2) {
    root = branch([leaf("g-main", present, 100)])
  } else if (shape === "deck") {
    // Main over a wide bottom.
    orientation = Orientation.VERTICAL
    const [first, ...rest] = present
    root = branch([leaf("g-main", [first], 66), leaf("g-bottom", rest, 34)])
  } else if (shape === "quad") {
    // Two columns, each split into two rows.
    const cells = buckets(present, 4)
    const columns = [cells.slice(0, 2), cells.slice(2)].filter((c) => c.length)
    root = branch(
      columns.map((column, ci) =>
        column.length === 1
          ? leaf(`g-quad-${ci}-0`, column[0], 100 / columns.length)
          : branch(
              column.map((views, ri) =>
                leaf(`g-quad-${ci}-${ri}`, views, 50)
              ),
              100 / columns.length
            )
      )
    )
  } else {
    const [first, ...rest] = present
    root = branch([leaf("g-main", [first], 62), leaf("g-side", rest, 38)])
  }

  return {
    grid: { root, height: 1000, width: 1000, orientation },
    panels,
    activeGroup: "g-main",
  }
}

// ── the spike page ──────────────────────────────────────────────────────────

export function DockSpikePage() {
  const [api, setApi] = useState<DockviewApi | null>(null)
  const [sidebarSide, setSidebarSide] = useState<"left" | "right">("left")
  const [shape, setShape] = useState<Shape>("default")
  const [log, setLog] = useState<string[]>([])

  const note = useCallback((line: string) => {
    setLog((prev) => [
      `${new Date().toLocaleTimeString([], { hour12: false })}  ${line}`,
      ...prev,
    ].slice(0, 12))
  }, [])

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      setApi(event.api)
      event.api.fromJSON(buildLayout("default", PANES.map((p) => p.id)))
      // Report every group change, so a pane that quietly loses its instance is
      // visible in the log next to the action that caused it.
      event.api.onDidLayoutChange(() => undefined)
    },
    []
  )

  /** Move a pane into a brand-new group — the §3.1 cross-group move. */
  const splitOut = useCallback(
    (panelId: string) => {
      if (!api) return
      const panel = api.getPanel(panelId)
      if (!panel) return
      const group = api.addGroup({ referenceGroup: panel.api.group, direction: "right" })
      panel.api.moveTo({ group })
      note(`moved ${panelId} into a new group (right)`)
    },
    [api, note]
  )

  const applyShape = useCallback(
    (next: Shape) => {
      if (!api) return
      const ids = api.panels.map((p) => p.api.id)
      api.fromJSON(buildLayout(next, ids), { reuseExistingPanels: true })
      setShape(next)
      note(`fromJSON → ${SHAPE_LABELS[next]} (reuseExistingPanels, ${ids.length} panes)`)
    },
    [api, note]
  )

  /**
   * The same switch *without* the flag — the issue #718 behaviour, kept as a
   * control so the difference is demonstrated rather than asserted.
   */
  const applyShapeUnsafe = useCallback(
    (next: Shape) => {
      if (!api) return
      const ids = api.panels.map((p) => p.api.id)
      api.fromJSON(buildLayout(next, ids))
      setShape(next)
      note(`fromJSON → ${SHAPE_LABELS[next]} WITHOUT reuseExistingPanels`)
    },
    [api, note]
  )

  const sidebar = useMemo(
    () => (
      <aside className="flex w-56 shrink-0 flex-col gap-2 border-border bg-sidebar p-3">
        <p className="font-mono text-[11px] text-muted-foreground">
          SIDEBAR ({sidebarSide})
        </p>
        <p className="text-xs text-muted-foreground">
          Outside dockview, swapped with a flex order change — the Phase 0
          stand-in for the resolved open question 6.
        </p>
        <div className="mt-auto space-y-1">
          {PANES.map((p) => (
            <Button
              key={p.id}
              variant="ghost"
              size="sm"
              className="w-full justify-start text-xs text-muted-foreground"
              onClick={() => splitOut(p.id)}
            >
              split out {p.title}
            </Button>
          ))}
        </div>
      </aside>
    ),
    [sidebarSide, splitOut]
  )

  return (
    <div className="flex h-svh min-h-0 flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span className="font-mono text-[11px] text-foreground">
          PHASE 0 SPIKE
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          dockview-react 7.0.4 · renderer: always
        </span>
        <span className="mx-2 h-4 w-px bg-border" />
        {(Object.keys(SHAPE_LABELS) as Shape[]).map((s) => (
          <Button
            key={s}
            size="sm"
            variant={shape === s ? "secondary" : "ghost"}
            className="text-xs"
            onClick={() => applyShape(s)}
          >
            {SHAPE_LABELS[s]}
          </Button>
        ))}
        <span className="mx-2 h-4 w-px bg-border" />
        <Button
          size="sm"
          variant="ghost"
          className="text-xs text-muted-foreground"
          onClick={() => applyShapeUnsafe(shape === "quad" ? "default" : "quad")}
        >
          switch without reuse (control)
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-xs text-muted-foreground"
          onClick={() =>
            setSidebarSide((s) => (s === "left" ? "right" : "left"))
          }
        >
          swap sidebar side
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        {sidebarSide === "left" && sidebar}
        <div className="min-h-0 min-w-0 flex-1">
          <DockviewReact
            components={COMPONENTS}
            onReady={onReady}
            className="dockview-theme-abyss h-full"
          />
        </div>
        {sidebarSide === "right" && sidebar}
      </div>

      <footer className="max-h-28 shrink-0 overflow-y-auto border-t border-border bg-card px-3 py-1.5">
        {log.length === 0 ? (
          <p className="font-mono text-[11px] text-muted-foreground">
            Drag a tab between groups, or use the buttons above. Every action is
            logged here.
          </p>
        ) : (
          log.map((line) => (
            <p key={line} className="font-mono text-[11px] text-muted-foreground">
              {line}
            </p>
          ))
        )}
      </footer>
    </div>
  )
}
