import { Bot, Boxes, Hammer, Hexagon, Sparkles } from "lucide-react"
import type { ComponentType } from "react"
import { Link, useLocation } from "react-router-dom"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
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

/**
 * Cursor-style left navigation for Hearthstack: a collapsible icon sidebar with
 * a brand header, the primary destinations, and a footer. Mirrors the swarmcore
 * shell's structure while carrying Hearthstack's real routes.
 */
export function AppSidebar() {
  const { pathname } = useLocation()
  const { isMobile, setOpenMobile } = useSidebar()

  const closeMobile = () => {
    if (isMobile) setOpenMobile(false)
  }
  const isActive = (href: string) =>
    pathname === href || pathname.startsWith(`${href}/`)

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-1 group-data-[collapsible=icon]:justify-center">
          <Link
            to="/agents"
            onClick={closeMobile}
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1.5 py-1 group-data-[collapsible=icon]:hidden"
          >
            <Hexagon className="size-6 shrink-0 text-primary" />
            <span className="truncate text-lg font-bold tracking-tight text-foreground">
              Hearthstack
            </span>
          </Link>
          <SidebarTrigger className="shrink-0" />
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Platform</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    isActive={isActive(item.to)}
                    tooltip={item.label}
                    asChild
                  >
                    <Link to={item.to} onClick={closeMobile}>
                      <item.icon className="size-4" />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <div className="flex items-center gap-2 group-data-[collapsible=icon]:justify-center">
              <ThemeToggle />
              <span className="text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
                Toggle theme
              </span>
            </div>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  )
}
