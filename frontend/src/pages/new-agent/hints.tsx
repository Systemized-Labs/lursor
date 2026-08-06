import { useEffect, useMemo, useState, type ReactNode } from "react"

import { isElectron } from "@/lib/platform"
import { MOD } from "@/lib/shortcuts"

/**
 * The rotating one-liner under the home composer.
 *
 * Every hint here has to be true of *this* build — the line it replaced pitched
 * a `/add-plugin` command that does not exist, which is worse than an empty
 * footer. So each one names something checked against its implementation:
 * chords come from `lib/shortcuts.ts`, slash commands from
 * `components/chat/commands/registry.ts`, and `@` sources from
 * `components/chat/mentions/sources.ts`. Anything only bound in the desktop
 * shell is marked `desktopOnly` and never shown in a browser, where those chords
 * belong to the browser itself.
 */

/** A chord or command token, styled like the surrounding UI's inline code. */
function Key({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-muted px-1 py-0.5 text-xs text-foreground">
      {children}
    </code>
  )
}

interface Hint {
  id: string
  body: ReactNode
  /** Only bound inside the desktop shell (see `lib/shortcuts.ts`). */
  desktopOnly?: boolean
}

const HINTS: Hint[] = [
  {
    id: "palette",
    body: (
      <>
        <Key>{MOD}K</Key> jumps to any project, conversation, file, or skill
      </>
    ),
  },
  {
    id: "plan",
    body: (
      <>
        Start with <Key>/plan</Key> to get a plan before anything is edited
      </>
    ),
  },
  {
    id: "ask",
    body: (
      <>
        <Key>/ask</Key> answers questions read-only — nothing gets written
      </>
    ),
  },
  {
    id: "mentions",
    body: (
      <>
        <Key>@</Key> pulls a file, a plan, or a skill into the conversation
      </>
    ),
  },
  {
    id: "goal",
    body: (
      <>
        <Key>/goal</Key> keeps an agent working until your success condition is
        met
      </>
    ),
  },
  {
    id: "compact",
    body: (
      <>
        Long conversation? <Key>/compact</Key> summarizes it to free up context
      </>
    ),
  },
  {
    id: "queue",
    body: <>Keep typing while an agent works — your message queues up next</>,
  },
  {
    id: "attachments",
    // Paste and drop are the chat composer's, not this page's — say where.
    body: <>Paste or drop a screenshot into a chat to attach it</>,
  },
  {
    id: "sidebar",
    body: (
      <>
        <Key>{MOD}B</Key> hides the sidebar; <Key>⇧{MOD}\</Key> opens the layouts
        picker
      </>
    ),
  },
  {
    id: "workspaces",
    desktopOnly: true,
    body: (
      <>
        <Key>{MOD}1</Key>–<Key>{MOD}9</Key> switch projects; double-tap{" "}
        <Key>{MOD}</Key> for the last one
      </>
    ),
  },
  {
    id: "new-session",
    desktopOnly: true,
    body: (
      <>
        <Key>{MOD}N</Key> starts a new session from anywhere
      </>
    ),
  },
  {
    id: "repo-skills",
    body: (
      <>
        Skills committed to a repo's <Key>.agents/skills</Key> load themselves in
        that project
      </>
    ),
  },
  {
    id: "settings",
    body: (
      <>
        <Key>{MOD},</Key> opens settings — models, providers, and agent
        capabilities
      </>
    ),
  },
]

const ROTATE_MS = 11_000

/** A fresh shuffle of the hints that apply here, newest order per mount. */
function shuffledHints(): Hint[] {
  const pool = HINTS.filter((hint) => isElectron || !hint.desktopOnly)
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j], pool[i]]
  }
  return pool
}

/**
 * One hint at a time, swapped on a timer.
 *
 * The order is a shuffle drawn once per mount rather than an independent random
 * pick per tick: a fresh pick can show the same hint twice in a row and can
 * starve one for a whole session, where a shuffled cycle still opens on a
 * different hint every launch and reaches all of them.
 */
export function RotatingHint({ className }: { className?: string }) {
  const hints = useMemo(shuffledHints, [])
  const [index, setIndex] = useState(0)

  useEffect(() => {
    if (hints.length < 2) return
    const timer = setInterval(
      () => setIndex((i) => (i + 1) % hints.length),
      ROTATE_MS
    )
    return () => clearInterval(timer)
  }, [hints.length])

  const hint = hints[index]
  if (!hint) return null

  return (
    <p className={className}>
      {/* Keyed on the hint so React remounts the span and the fade replays. */}
      <span key={hint.id} className="animate-in fade-in-0 duration-700">
        {hint.body}
      </span>
    </p>
  )
}
