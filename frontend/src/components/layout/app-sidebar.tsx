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
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              tooltip="Hearthstack"
              className="gap-2.5"
              asChild
            >
              <Link to="/agents" onClick={closeMobile}>
                <Hexagon className="!size-6 shrink-0 text-primary" />
                <span className="text-lg font-bold tracking-tight text-foreground">
                  Hearthstack
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
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
