import {
  ChartBar,
  ChatCentered,
  FileCode,
  FilmSlate,
  GitDiff,
  Globe,
  ImageSquare,
  Stack,
  Terminal,
  type Icon,
} from "@phosphor-icons/react"
import type { DockviewPanelRenderer, IDockviewPanel } from "dockview-react"

/**
 * The kinds of surface a pane can be.
 *
 * The five workspace surfaces, plus the four §3.6 promised: artifacts, usage,
 * video and image. Nothing is listed here without a component behind it — a kind
 * with nothing to render is a tab you can open onto nothing.
 *
 * Note that not every kind is *workspace*-scoped. Usage is cross-workspace by
 * nature, and Video and Image are scoped to a LAIOS connection rather than to a
 * repo. They are still panes, and they can sit in a workspace's layout beside a
 * chat — a pane is a surface, not a claim about what owns it. What they cannot do
 * is depend on `workspaceId`, and none of them does.
 */
export type PaneKind =
  | "chat"
  | "changes"
  | "file"
  | "preview"
  | "terminal"
  | "artifacts"
  | "usage"
  | "video"
  | "image"

/**
 * Our per-pane data, carried in dockview's `params`.
 *
 * Kind-specific addressing: which thread a chat is on, which file or URL a pane
 * was pointed at. Everything here has to survive `JSON.stringify` — it goes
 * through `toJSON()` into localStorage and comes back out on reload.
 */
export interface PaneParams {
  kind: PaneKind
  /** Chat: the open conversation, or null for a new one. */
  threadId?: string | null
  /**
   * Chat: an *ephemeral* pane, VS Code's preview tab.
   *
   * A single click in the sidebar opens a conversation here and the next single
   * click re-addresses the same pane, so browsing a project's sessions costs one
   * tab rather than one per row. Anything that says "I mean to keep this" —
   * double-clicking the row or the tab, dragging the tab, sending a turn — clears
   * the flag, and clearing it is all promotion is.
   *
   * Absent rather than `false` on a pane that stays: `updateParameters` deletes a
   * key set to `undefined`, which keeps a promoted pane's params identical to one
   * that was never a preview.
   */
  preview?: boolean
  /** Files: a workspace-relative path. */
  path?: string
  /** Preview: the URL it was last on. */
  url?: string
  [key: string]: unknown
}

export interface PaneKindDef {
  title: string
  icon: Icon
  /**
   * **The single most important line of configuration in the rewrite** (§3.6).
   *
   * `always` renders the pane into dockview's shared overlay container, tracked
   * to its group's bounding box, so moving it between groups never reparents its
   * DOM node — which is what keeps a PTY, an iframe and a Monaco buffer alive.
   * Phase 0 measured this; see the plan's §3.8.
   *
   * The cost is that a hidden pane keeps running: effects, subscriptions and
   * timers all continue. That is what we want for a streaming chat and a
   * terminal, and it is why every kind here is `always` — all five are either
   * stateful sessions or hold scroll position and unsaved edits. A cheap,
   * stateless kind should use `onlyWhenVisible` instead, and Phase 6 will have
   * some.
   */
  renderer: DockviewPanelRenderer
}

export const PANE_KINDS: Record<PaneKind, PaneKindDef> = {
  chat: { title: "Chat", icon: ChatCentered, renderer: "always" },
  changes: { title: "Changes", icon: GitDiff, renderer: "always" },
  file: { title: "Files", icon: FileCode, renderer: "always" },
  preview: { title: "Preview", icon: Globe, renderer: "always" },
  terminal: { title: "Terminal", icon: Terminal, renderer: "always" },
  artifacts: { title: "Artifacts", icon: Stack, renderer: "always" },
  usage: { title: "Usage", icon: ChartBar, renderer: "always" },
  video: { title: "Video", icon: FilmSlate, renderer: "always" },
  image: { title: "Image", icon: ImageSquare, renderer: "always" },
}

/**
 * The kinds offered by a zone's `+` menu, in order.
 *
 * Every kind is `always`, which means the plan's "except the trivially cheap ones"
 * never got a taker. Usage is the closest candidate — it is charts derived from
 * queries, so rebuilding it costs nothing on the server — but it holds a workspace
 * filter and a date range, and silently resetting those every time the pane is
 * hidden is a worse trade than the work it keeps doing. If hidden-pane cost ever
 * shows up in a profile, Usage is where to start, and the fix is
 * `onlyWhenVisible` plus lifting those two selections out of the component.
 */
export const ADDABLE_KINDS: PaneKind[] = [
  "chat",
  "changes",
  "file",
  "preview",
  "terminal",
  "artifacts",
  "usage",
  "video",
  "image",
]

/**
 * The kinds that need a workspace to mean anything.
 *
 * Used to decide what a *global* pane layout — the one behind `/analytics`,
 * `/video`, `/image` and `/artifacts`, keyed `_global` — is allowed to hold. A
 * terminal with no workspace would open a shell in whatever directory the backend
 * defaults to, which is not a surface anyone asked for.
 */
export const WORKSPACE_KINDS: PaneKind[] = [
  "chat",
  "changes",
  "file",
  "preview",
  "terminal",
]

/**
 * The kinds a phone can show full-screen.
 *
 * Chat is excluded because on mobile it is not one of the switchable surfaces —
 * it *is* the base view the bottom bar switches away from.
 */
export type MobilePaneKind = Exclude<PaneKind, "chat">

export function isPaneKind(value: unknown): value is PaneKind {
  return typeof value === "string" && value in PANE_KINDS
}

/**
 * Our params off a live panel.
 *
 * Dockview types `panel.params` as an open record, so reading ours out of it takes
 * a cast. **The cast lives here so it lives nowhere else** — it used to be written
 * out at nine call sites across five files, each one re-asserting the same thing and
 * each one a place the shape could drift.
 *
 * `undefined` for a panel dockview created without params, which a hand-edited
 * layout key can still produce.
 *
 * The dockview import this needs is `import type`, and has to stay that way:
 * `pane-kinds` is reached from the shell on every route, so a value import would
 * pull dockview into the entry chunk past the lazy pane host. Same rule as
 * `layout-shapes` and `bottom-panel`; see the note on `HORIZONTAL`.
 */
export function paneParamsOf(panel: IDockviewPanel): PaneParams | undefined {
  return panel.params as PaneParams | undefined
}

/** A pane's kind, off its live panel. */
export function paneKindOf(panel: IDockviewPanel): PaneKind | undefined {
  return paneParamsOf(panel)?.kind
}

/**
 * A prefixed unique id: `crypto.randomUUID` where it exists, else time plus random.
 *
 * The probe is not paranoia — `crypto.randomUUID` is only exposed on secure
 * contexts, and the app is reachable over the LAN on plain http, which is exactly
 * the case that has no `randomUUID` to call.
 *
 * The fallback carries a timestamp as well as the random part, so two ids minted in
 * the same millisecond by different tabs still differ and one minted later sorts
 * later — cheap, and the reason not to trust `Math.random` alone for something that
 * keys persistent storage.
 */
export function newId(prefix: string): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `${prefix}-${crypto.randomUUID()}`
    }
  } catch {
    // Fall through to the Math.random id below.
  }
  return `${prefix}-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}

/**
 * A globally unique pane id.
 *
 * Unique across workspaces *and* across reloads, not just within a session: panes
 * key their own state off this id via `lib/tab-storage.ts`, and those keys are
 * global, so a recycled id would hand a new pane a dead one's preview URL. Same
 * rule and same reasoning as the tab ids it replaces.
 */
export function newPaneId(): string {
  return newId("p")
}
