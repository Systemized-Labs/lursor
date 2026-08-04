import { isElectron, isMacElectron } from "@/lib/platform"

/**
 * What the app's keyboard shortcuts are, for the Settings dialog to show.
 *
 * **This is documentation, not a binding layer.** Every chord below is still
 * registered at its own call site — `ui/sidebar.tsx` owns ⌘B, `command-palette`
 * owns ⌘K, `use-workspace-switch` owns ⌘1–⌘9 and the double-⌘ tap,
 * `editor-pane` owns find/replace, `right-dock` owns Esc. The plan called this
 * "a table over the keybind registry"; there is no registry, and inventing one
 * would mean rewriting nine unrelated key handlers to serve a help table.
 *
 * The honest trade is stated rather than hidden: this list can drift from the
 * handlers. It is one file, next to nothing to keep in step, and a wrong help
 * table is a smaller problem than nine call sites indirecting through a registry
 * they do not otherwise need. If shortcuts ever become user-rebindable, *that* is
 * when the registry has to exist — and then this file becomes its labels.
 *
 * Chords are written for the platform: ⌘ on a Mac, Ctrl elsewhere. Anything that
 * only works in the desktop shell says so, because ⌘1–⌘9 in a browser is the
 * browser's own tab switcher and never reaches us.
 */

export interface Shortcut {
  /** Rendered chord, already platform-resolved. */
  keys: string
  description: string
  /** Where it applies — grouped under this in the table. */
  group: string
  /** Only bound inside the Electron shell. */
  desktopOnly?: boolean
}

const MOD = isMacElectron || isMac() ? "⌘" : "Ctrl"
const SHIFT = isMacElectron || isMac() ? "⇧" : "Shift+"
const ALT = isMacElectron || isMac() ? "⌥" : "Alt+"

/** Mac in a plain browser too, not just in Electron — the chords still differ. */
function isMac(): boolean {
  if (typeof navigator === "undefined") return false
  return /mac/i.test(navigator.platform || navigator.userAgent)
}

const chord = (...parts: string[]) => parts.join("")

export const SHORTCUTS: Shortcut[] = [
  // ── Navigation ────────────────────────────────────────────────────────────
  {
    keys: chord(MOD, "N"),
    description: "Start a new session",
    group: "Navigation",
    desktopOnly: true,
  },
  {
    keys: chord(MOD, "K"),
    description: "Open the command palette",
    group: "Navigation",
  },
  {
    keys: `${chord(MOD, "]")} / ${chord(MOD, "[")}`,
    description: "Cycle the command palette's filter",
    group: "Navigation",
  },
  {
    keys: chord(MOD, ","),
    description: "Open settings",
    group: "Navigation",
  },
  {
    keys: `${chord(MOD, "1")}–${chord(MOD, "9")}`,
    description: "Switch to the workspace at that position in the sidebar",
    group: "Navigation",
    desktopOnly: true,
  },
  {
    keys: `${MOD} ${MOD}`,
    description: "Double-tap: back to the previous workspace",
    group: "Navigation",
    desktopOnly: true,
  },

  // ── Layout ────────────────────────────────────────────────────────────────
  {
    keys: chord(MOD, "B"),
    description: "Show or hide the sidebar",
    group: "Layout",
  },

  {
    keys: "Esc",
    description: "Restore a maximized panel",
    group: "Layout",
  },

  // ── Files ─────────────────────────────────────────────────────────────────
  {
    keys: chord(MOD, "F"),
    description: "Find in the open file",
    group: "Files",
  },
  {
    keys: isMacElectron || isMac() ? chord(ALT, MOD, "F") : "Ctrl+H",
    description: "Replace in the open file",
    group: "Files",
  },

  // ── Conversations ─────────────────────────────────────────────────────────
  {
    keys: `${MOD}-click`,
    description: "Add or remove a conversation from the selection",
    group: "Conversations",
  },
  {
    keys: `${SHIFT.replace("+", "")}-click`,
    description: "Select a range of conversations",
    group: "Conversations",
  },
  {
    keys: "Esc",
    description: "Clear the conversation selection",
    group: "Conversations",
  },

  // ── Generating ────────────────────────────────────────────────────────────
  {
    keys: chord(MOD, "↵"),
    description: "Start a video or image generation from its composer",
    group: "Generating",
  },
]

/** Shortcuts that actually work here, grouped in declaration order. */
export function activeShortcutGroups(): { group: string; items: Shortcut[] }[] {
  const groups: { group: string; items: Shortcut[] }[] = []
  for (const item of SHORTCUTS) {
    if (item.desktopOnly && !isElectron) continue
    const existing = groups.find((g) => g.group === item.group)
    if (existing) existing.items.push(item)
    else groups.push({ group: item.group, items: [item] })
  }
  return groups
}
