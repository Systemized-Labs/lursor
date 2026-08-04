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
import type { DockviewPanelRenderer } from "dockview-react"

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
 * A globally unique pane id.
 *
 * Unique across workspaces *and* across reloads, not just within a session: panes
 * key their own state off this id via `lib/tab-storage.ts`, and those keys are
 * global, so a recycled id would hand a new pane a dead one's preview URL. Same
 * rule and same reasoning as the tab ids it replaces.
 */
export function newPaneId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `p-${crypto.randomUUID()}`
    }
  } catch {
    // Fall through to the Math.random id below.
  }
  return `p-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
}
