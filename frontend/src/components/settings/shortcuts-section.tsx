import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card"
import { activeShortcutGroups } from "@/lib/shortcuts"
import { isElectron } from "@/lib/platform"

/**
 * Every keyboard shortcut the app binds, grouped by where it applies.
 *
 * Read-only. Nothing here is rebindable, and the table says so rather than
 * implying otherwise with edit affordances that do nothing — see the note in
 * `lib/shortcuts.ts` for why there is no registry behind this yet.
 *
 * Desktop-only chords are filtered out in the browser rather than shown greyed:
 * ⌘1–⌘9 is the browser's own tab switcher there and never reaches the app, so
 * listing it would be listing something that does not work.
 */
export function ShortcutsSection() {
  const groups = activeShortcutGroups()

  return (
    /* No card title: the dialog's pane heading already reads "Keyboard
       shortcuts", and repeating it would say the same thing twice in a row. */
    <Card>
      <CardHeader>
        <CardDescription>
          {isElectron
            ? "Not rebindable yet."
            : "Not rebindable yet. Workspace switching shortcuts are desktop-only — in a browser those chords belong to the browser."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {groups.map(({ group, items }) => (
          <div key={group} className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {group}
            </p>
            <ul className="divide-y divide-border/60">
              {items.map((item) => (
                <li
                  key={`${group}-${item.keys}-${item.description}`}
                  className="flex items-baseline justify-between gap-4 py-1.5"
                >
                  <span className="min-w-0 text-sm text-foreground">
                    {item.description}
                  </span>
                  <kbd className="shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                    {item.keys}
                  </kbd>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
