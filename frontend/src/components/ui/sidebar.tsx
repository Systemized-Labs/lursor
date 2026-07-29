import * as React from "react"

import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { TooltipProvider } from "@/components/ui/tooltip"

/**
 * The shell primitive: a provider, the fixed sidebar box, its drag handle and
 * the content inset. What the box *contains* is the app's business — see
 * `layout/nav-rail.tsx` and `layout/sidebar-panel.tsx`.
 *
 * This was vendored from shadcn with a full menu API (SidebarMenu, MenuButton,
 * MenuSub, GroupLabel, …). The rail-and-panel redesign left every one of them
 * with zero call sites, and they encoded a collapsed state that no longer
 * exists — a 3rem icon strip — so keeping them would have meant a second, dead
 * definition of how a sidebar row looks. They're gone; the file is no longer a
 * clean `shadcn add` target and hasn't been since it grew drag-to-resize.
 */

const SIDEBAR_COOKIE_NAME = "sidebar:state"
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7
// Fluid on phones: fill most of the viewport but cap on larger handsets so it
// never becomes an awkwardly wide panel. Sized for the rail *and* the panel —
// 68px of rail plus ~300px of list, which on a 390px phone still leaves a
// dismiss gutter.
const SIDEBAR_WIDTH_MOBILE = "min(23rem, 92vw)"
// The destination rail, always on screen. Collapsing the sidebar hides the
// panel and leaves this — a better collapsed state than a 3rem icon strip,
// because the rail's labels stay readable at this width.
const SIDEBAR_GUTTER_WIDTH = 68
// The rail's other width, where a tile shows its name beside its icon. Wide
// enough for ~20 characters of the shell font, which is what it takes for names
// like `cat-adoption` and `cat-landing` to be told apart by reading rather than
// by hovering — the thing 68px cannot do at any font size.
const SIDEBAR_RAIL_WIDTH_EXPANDED = 232
const SIDEBAR_RAIL_STORAGE_KEY = "sidebar:rail"
const SIDEBAR_KEYBOARD_SHORTCUT = "b"

// Drag-to-resize bounds (px) for the *panel*; the rail is fixed. The default
// matches SIDEBAR_WIDTH (16rem).
const SIDEBAR_WIDTH_STORAGE_KEY = "sidebar:width"
const SIDEBAR_WIDTH_DEFAULT = 256
const SIDEBAR_WIDTH_MIN = 200
const SIDEBAR_WIDTH_MAX = 480

type SidebarContextProps = {
  state: "expanded" | "collapsed"
  open: boolean
  setOpen: (open: boolean) => void
  openMobile: boolean
  setOpenMobile: (open: boolean) => void
  isMobile: boolean
  toggleSidebar: () => void
  width: number
  setWidth: (width: number) => void
  isResizing: boolean
  setIsResizing: (resizing: boolean) => void
  /** Whether the rail is showing names beside its icons. */
  railExpanded: boolean
  toggleRail: () => void
  /** The rail's current width in px — what `--sidebar-width-icon` resolves to. */
  railWidth: number
}

const SidebarContext = React.createContext<SidebarContextProps | null>(null)

function useSidebar() {
  const context = React.useContext(SidebarContext)
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.")
  }
  return context
}

const SidebarProvider = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div"> & {
    defaultOpen?: boolean
    open?: boolean
    onOpenChange?: (open: boolean) => void
  }
>(
  (
    {
      defaultOpen = true,
      open: openProp,
      onOpenChange: setOpenProp,
      className,
      style,
      children,
      ...props
    },
    ref
  ) => {
    const isMobile = useIsMobile()
    const [openMobile, setOpenMobile] = React.useState(false)

    // Drag-to-resize width (desktop only), persisted across refreshes.
    const [width, _setWidth] = React.useState(() => {
      if (typeof window === "undefined") return SIDEBAR_WIDTH_DEFAULT
      const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY))
      return stored >= SIDEBAR_WIDTH_MIN && stored <= SIDEBAR_WIDTH_MAX
        ? stored
        : SIDEBAR_WIDTH_DEFAULT
    })
    const [isResizing, setIsResizing] = React.useState(false)
    const setWidth = React.useCallback((value: number) => {
      const clamped = Math.min(
        SIDEBAR_WIDTH_MAX,
        Math.max(SIDEBAR_WIDTH_MIN, Math.round(value))
      )
      _setWidth(clamped)
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clamped))
    }, [])

    // The rail's width is a second, independent axis: ⌘B decides whether the
    // *panel* is there, ⇧⌘B decides whether the rail carries names. Two toggles
    // because they answer different questions — "do I need the conversation
    // list" and "can I read my workspaces" — and collapsing one to the other
    // would mean you cannot have a labelled rail without a panel beside it.
    const [railExpanded, setRailExpanded] = React.useState(() => {
      if (typeof window === "undefined") return false
      return window.localStorage.getItem(SIDEBAR_RAIL_STORAGE_KEY) === "expanded"
    })
    const toggleRail = React.useCallback(() => {
      setRailExpanded((expanded) => {
        const next = !expanded
        try {
          window.localStorage.setItem(
            SIDEBAR_RAIL_STORAGE_KEY,
            next ? "expanded" : "icons"
          )
        } catch {
          // Ignore quota / disabled-storage errors — this is a preference.
        }
        return next
      })
    }, [])

    // Internal open state; `openProp`/`setOpenProp` allow external control.
    const [_open, _setOpen] = React.useState(defaultOpen)
    const open = openProp ?? _open
    const setOpen = React.useCallback(
      (value: boolean | ((value: boolean) => boolean)) => {
        const openState = typeof value === "function" ? value(open) : value
        if (setOpenProp) {
          setOpenProp(openState)
        } else {
          _setOpen(openState)
        }
        // Persist across refreshes.
        document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`
      },
      [setOpenProp, open]
    )

    const toggleSidebar = React.useCallback(() => {
      return isMobile
        ? setOpenMobile((open) => !open)
        : setOpen((open) => !open)
    }, [isMobile, setOpen, setOpenMobile])

    React.useEffect(() => {
      const handleKeyDown = (event: KeyboardEvent) => {
        // `event.key` is case-folded by shift, so the chord is matched on the
        // unshifted letter — otherwise ⇧⌘B looks for "b" and finds "B".
        if (
          event.key.toLowerCase() !== SIDEBAR_KEYBOARD_SHORTCUT ||
          !(event.metaKey || event.ctrlKey)
        ) {
          return
        }
        event.preventDefault()
        if (event.shiftKey) toggleRail()
        else toggleSidebar()
      }
      window.addEventListener("keydown", handleKeyDown)
      return () => window.removeEventListener("keydown", handleKeyDown)
    }, [toggleSidebar, toggleRail])

    const state = open ? "expanded" : "collapsed"
    // Names cost the panel width it does not have on a phone: the drawer holds
    // the rail *and* the list in ~368px, so an expanded rail would leave the
    // conversations about 130px. The preference is remembered either way and
    // takes effect on a wider screen.
    const railWidth =
      railExpanded && !isMobile
        ? SIDEBAR_RAIL_WIDTH_EXPANDED
        : SIDEBAR_GUTTER_WIDTH

    const contextValue = React.useMemo<SidebarContextProps>(
      () => ({
        state,
        open,
        setOpen,
        isMobile,
        openMobile,
        setOpenMobile,
        toggleSidebar,
        width,
        setWidth,
        isResizing,
        setIsResizing,
        railExpanded,
        toggleRail,
        railWidth,
      }),
      [
        state,
        open,
        setOpen,
        isMobile,
        openMobile,
        setOpenMobile,
        toggleSidebar,
        width,
        setWidth,
        isResizing,
        railExpanded,
        toggleRail,
        railWidth,
      ]
    )

    return (
      <SidebarContext.Provider value={contextValue}>
        <TooltipProvider delayDuration={0}>
          <div
            data-resizing={isResizing}
            style={
              {
                // The panel; `--sidebar-width-total` adds the rail beside it.
                // Both are live values: the rail widens to carry names, and
                // everything sized off these tokens — the collapsed sidebar, the
                // content inset, the fixed overlay — follows without a second
                // definition of how wide the rail is.
                "--sidebar-width": `${width}px`,
                "--sidebar-width-icon": `${railWidth}px`,
                "--sidebar-width-total": `${width + railWidth}px`,
                ...style,
              } as React.CSSProperties
            }
            className={cn(
              "group/sidebar-wrapper flex min-h-svh w-full has-[[data-variant=inset]]:bg-sidebar",
              className
            )}
            ref={ref}
            {...props}
          >
            {children}
          </div>
        </TooltipProvider>
      </SidebarContext.Provider>
    )
  }
)
SidebarProvider.displayName = "SidebarProvider"

const Sidebar = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"div"> & {
    side?: "left" | "right"
    variant?: "sidebar" | "floating" | "inset"
    collapsible?: "offcanvas" | "icon" | "none"
  }
>(
  (
    {
      side = "left",
      variant = "sidebar",
      collapsible = "offcanvas",
      className,
      children,
      ...props
    },
    ref
  ) => {
    const { isMobile, state, openMobile, setOpenMobile } = useSidebar()

    if (collapsible === "none") {
      return (
        <div
          className={cn(
            "flex h-full w-(--sidebar-width-total) flex-col bg-sidebar text-sidebar-foreground",
            className
          )}
          ref={ref}
          {...props}
        >
          {children}
        </div>
      )
    }

    if (isMobile) {
      return (
        <Sheet open={openMobile} onOpenChange={setOpenMobile} {...props}>
          <SheetContent
            data-sidebar="sidebar"
            data-mobile="true"
            className="w-(--sidebar-width) bg-sidebar p-0 text-sidebar-foreground [&>button]:hidden"
            style={
              {
                "--sidebar-width": SIDEBAR_WIDTH_MOBILE,
              } as React.CSSProperties
            }
            side={side}
          >
            <SheetHeader className="sr-only">
              <SheetTitle>Sidebar</SheetTitle>
              <SheetDescription>Displays the mobile sidebar.</SheetDescription>
            </SheetHeader>
            {/* Safe-area insets so the header clears the status bar and the
                footer clears the home indicator in standalone mode. */}
            <div className="flex h-full w-full flex-col pt-safe pb-safe">
              {children}
            </div>
          </SheetContent>
        </Sheet>
      )
    }

    return (
      <div
        ref={ref}
        className="group peer hidden text-sidebar-foreground md:block"
        data-state={state}
        data-collapsible={state === "collapsed" ? collapsible : ""}
        data-variant={variant}
        data-side={side}
      >
        {/* Handles the sidebar gap on desktop. */}
        <div
          className={cn(
            "relative w-(--sidebar-width-total) bg-transparent transition-[width] duration-200 ease-linear",
            "group-data-[resizing=true]/sidebar-wrapper:transition-none",
            "group-data-[collapsible=offcanvas]:w-0",
            "group-data-[side=right]:rotate-180",
            variant === "floating" || variant === "inset"
              ? "group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)_+_1rem)]"
              : "group-data-[collapsible=icon]:w-(--sidebar-width-icon)"
          )}
        />
        <div
          className={cn(
            "fixed inset-y-0 z-10 hidden h-svh w-(--sidebar-width-total) transition-[left,right,width] duration-200 ease-linear group-data-[resizing=true]/sidebar-wrapper:transition-none md:flex",
            side === "left"
              ? "left-0 group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width-total)*-1)]"
              : "right-0 group-data-[collapsible=offcanvas]:right-[calc(var(--sidebar-width-total)*-1)]",
            variant === "floating" || variant === "inset"
              ? "p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)_+_1rem_+2px)]"
              : "group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l",
            className
          )}
          {...props}
        >
          <div
            data-sidebar="sidebar"
            className="flex h-full w-full flex-col bg-sidebar group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:border-sidebar-border group-data-[variant=floating]:shadow"
          >
            {children}
          </div>
        </div>
      </div>
    )
  }
)
Sidebar.displayName = "Sidebar"

const SidebarRail = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button">
>(({ className, ...props }, ref) => {
  const { toggleSidebar, state, setWidth, setIsResizing, railWidth } =
    useSidebar()

  // The rail doubles as a drag handle: dragging resizes (when expanded), while
  // a plain click (no meaningful movement) still toggles the sidebar.
  const handleMouseDown = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      const startX = event.clientX
      const resizable = state === "expanded"
      // `side` lives as a data attribute on the sidebar wrapper, not in context.
      const side =
        event.currentTarget.closest("[data-side]")?.getAttribute("data-side") ??
        "left"
      let moved = false

      const onMove = (e: MouseEvent) => {
        if (Math.abs(e.clientX - startX) > 3) moved = true
        if (!resizable) return
        // The sidebar is anchored to the viewport edge, so the pointer's
        // distance from that edge is the total width — less the rail, which
        // sits between the edge and the resizable panel. Read from context
        // rather than the collapsed constant: with a labelled rail the panel
        // starts 232px in, and subtracting 68 there made the panel jump wider
        // than the cursor by the difference the moment you grabbed the handle.
        setWidth(
          (side === "left" ? e.clientX : window.innerWidth - e.clientX) -
            railWidth
        )
      }
      const onUp = () => {
        document.removeEventListener("mousemove", onMove)
        document.removeEventListener("mouseup", onUp)
        document.body.style.removeProperty("cursor")
        document.body.style.removeProperty("user-select")
        setIsResizing(false)
        if (!moved) toggleSidebar()
      }

      if (resizable) {
        setIsResizing(true)
        document.body.style.cursor = "col-resize"
        document.body.style.userSelect = "none"
      }
      document.addEventListener("mousemove", onMove)
      document.addEventListener("mouseup", onUp)
    },
    [state, setWidth, setIsResizing, toggleSidebar, railWidth]
  )

  return (
    <button
      ref={ref}
      data-sidebar="rail"
      aria-label="Toggle Sidebar"
      tabIndex={-1}
      onMouseDown={handleMouseDown}
      title="Toggle Sidebar"
      className={cn(
        "absolute inset-y-0 z-20 hidden w-4 -translate-x-1/2 transition-all ease-linear after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] hover:after:bg-sidebar-border group-data-[side=left]:-right-4 group-data-[side=right]:left-0 sm:flex",
        "[[data-side=left]_&]:cursor-w-resize [[data-side=right]_&]:cursor-e-resize",
        "[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize",
        "group-data-[collapsible=offcanvas]:translate-x-0 group-data-[collapsible=offcanvas]:after:left-full group-data-[collapsible=offcanvas]:hover:bg-sidebar",
        "[[data-side=left][data-collapsible=offcanvas]_&]:-right-2",
        "[[data-side=right][data-collapsible=offcanvas]_&]:-left-2",
        className
      )}
      {...props}
    />
  )
})
SidebarRail.displayName = "SidebarRail"

const SidebarInset = React.forwardRef<
  HTMLDivElement,
  React.ComponentProps<"main">
>(({ className, ...props }, ref) => {
  return (
    <main
      ref={ref}
      className={cn(
        "relative flex min-h-svh flex-1 flex-col bg-background",
        "peer-data-[variant=inset]:min-h-[calc(100svh-1rem)] md:peer-data-[variant=inset]:m-2 md:peer-data-[state=collapsed]:peer-data-[variant=inset]:ml-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow",
        className
      )}
      {...props}
    />
  )
})
SidebarInset.displayName = "SidebarInset"

export { Sidebar, SidebarInset, SidebarProvider, SidebarRail, useSidebar }
