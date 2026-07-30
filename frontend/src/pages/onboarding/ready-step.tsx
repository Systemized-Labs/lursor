import {
  ChatText,
  Gear,
  SidebarSimple,
  Terminal,
  type Icon,
} from "@phosphor-icons/react"

const ROWS: { icon: Icon; label: string; detail: string }[] = [
  {
    icon: SidebarSimple,
    label: "Sidebar",
    detail: "Your workspaces, agents, and folders — switch without losing a run",
  },
  {
    icon: ChatText,
    label: "Composer",
    detail: "Plan or build, / for skills, @ for context",
  },
  {
    icon: Terminal,
    label: "Dock",
    detail: "Terminal, files, git diff, and dev-server preview beside the chat",
  },
  {
    icon: Gear,
    label: "Settings",
    detail: "More models, GitHub, schedules, and agent defaults",
  },
]

/**
 * The last screen: names the four surfaces that make the workspace legible
 * before dropping the user into it. A static list rather than tooltips pinned to
 * live elements — nothing here can drift out of sync with a collapsed dock, a
 * phone layout, or a renamed panel.
 */
export function ReadyStep({ workspaceName }: { workspaceName?: string }) {
  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">
          You&apos;re set
        </h2>
        <p className="text-sm text-muted-foreground">
          {workspaceName
            ? `Here's the room you'll be working in — opening “${workspaceName}” next.`
            : "Here's the room you'll be working in."}
        </p>
      </div>

      <ul className="divide-y divide-border rounded-lg border border-border">
        {ROWS.map(({ icon: RowIcon, label, detail }) => (
          <li key={label} className="flex items-start gap-3 px-4 py-3">
            <RowIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{label}</p>
              <p className="text-xs text-muted-foreground">{detail}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
