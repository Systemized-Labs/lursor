import {
  ChatCentered,
  FileCode,
  GitDiff,
  Globe,
  Terminal,
  type Icon,
} from "@phosphor-icons/react"
import type { DockviewPanelRenderer } from "dockview-react"

/**
 * The kinds of surface a pane can be.
 *
 * Five for now — the four the right dock had, plus chat. The plan's §3.6 lists
 * artifacts, usage, video and image too; those arrive in Phase 6 with the panes
 * that render them, because a kind in this table with no component behind it is a
 * tab you can open onto nothing.
 */
export type PaneKind = "chat" | "changes" | "file" | "preview" | "terminal"

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
}

/** The kinds offered by a zone's `+` menu, in order. */
export const ADDABLE_KINDS: PaneKind[] = [
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
