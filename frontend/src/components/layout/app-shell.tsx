import { Bot, Boxes, Hammer, Sparkles } from "lucide-react"
import type { ComponentType } from "react"
import { NavLink, Outlet } from "react-router-dom"

import { cn } from "@/lib/utils"
import { ThemeToggle } from "@/components/theme-toggle"

interface NavItem {
  to: string
  label: string
  icon: ComponentType<{ className?: string }>
}

const navItems: NavItem[] = [
  { to: "/agents", label: "Agents", icon: Bot },
  { to: "/skills", label: "Skills", icon: Sparkles },
  { to: "/tools", label: "Tools", icon: Hammer },
  { to: "/workspaces", label: "Workspaces", icon: Boxes },
]

export function AppShell() {
  return (
    <div className="flex min-h-screen bg-background">
      <aside className="hidden w-60 shrink-0 flex-col border-r bg-card md:flex">
        <div className="flex h-16 items-center border-b px-6">
          <span className="text-lg font-semibold tracking-tight text-foreground">
            Hearthstack
          </span>
        </div>
        <nav className="flex flex-1 flex-col gap-1 p-3">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )
              }
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between border-b bg-card px-4 sm:px-6">
          <div className="flex items-center gap-4 md:hidden">
            <span className="text-lg font-semibold tracking-tight text-foreground">
              Hearthstack
            </span>
          </div>
          <nav className="flex items-center gap-1 md:hidden">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  cn(
                    "rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
                    isActive && "bg-accent text-accent-foreground"
                  )
                }
                aria-label={item.label}
              >
                <item.icon className="h-4 w-4" />
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
          </div>
        </header>

        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
