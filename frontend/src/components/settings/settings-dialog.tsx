import { useEffect, useRef } from "react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  categoryGroups,
  findCategory,
} from "@/components/settings/settings-categories"
import { useSettingsParam } from "@/components/settings/use-settings-param"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"

/**
 * Settings as a modal over whatever you were doing, not a page you leave for.
 *
 * Replaces two competing surfaces — `/settings` with its four `?tab=`s and
 * `/customization` with its six — plus the `/laios` and `/schedules`
 * destinations. One category rail, one scrolling pane, and state in `?settings=`
 * so it still deep-links and survives a reload (see `use-settings-param.ts`).
 *
 * Two widths. Most categories are forms and prose, which read worse the wider they
 * get, so they take a measured ~1100px column. Capabilities, Environment and
 * Schedules are two-pane browsers that spend every pixel they are given — the
 * standalone pages widened to `max-w-[100rem]` for exactly this reason — so they
 * get 95vw up to 1400px. That is mitigation 1 from the plan's §6; if it proves
 * insufficient in use, the named fallback is making Capabilities a pane instead of
 * a category.
 *
 * `data-browser-bounds` is the other half of that: the two-pane pages size
 * themselves against the fold, which inside a modal is far below the modal's own
 * bottom edge. The attribute tells `useBrowserBox` where the room actually ends.
 */
export function SettingsDialog() {
  const { open, category: categoryId, selectCategory, closeSettings } =
    useSettingsParam()
  const isMobile = useIsMobile()
  const category = findCategory(categoryId)
  const groups = categoryGroups()
  const paneRef = useRef<HTMLDivElement>(null)
  const activeRailRef = useRef<HTMLButtonElement>(null)

  // A new category starts at the top of its own content. Without this, opening a
  // long category after a short one lands you mid-page.
  useEffect(() => {
    if (paneRef.current) paneRef.current.scrollTop = 0
  }, [categoryId])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeSettings()
      }}
    >
      <DialogContent
        data-browser-bounds
        // Radix moves initial focus to the first focusable child, which is the
        // *first* rail item — so opening at any other category showed a focus
        // ring on "Model" while something else was highlighted as active. Two
        // controls claiming to be the current one. Focus the active category
        // instead, which is also where arrow/tab navigation should start.
        onOpenAutoFocus={(event) => {
          if (!activeRailRef.current) return
          event.preventDefault()
          activeRailRef.current.focus()
        }}
        className={cn(
          "flex h-[86vh] max-h-[860px] gap-0 overflow-hidden p-0",
          category.wide
            ? "w-[95vw] max-w-[1400px]"
            : "w-[92vw] max-w-[1100px]",
          // The rail stacks above the pane on a phone; below `md` there is not
          // enough width for a column of category names beside content.
          isMobile && "h-[92dvh] max-h-none w-screen max-w-none flex-col rounded-none"
        )}
      >
        {/* The dialog names itself for screen readers; the visible heading is the
            active category's own, on the pane. */}
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Configure agents, model providers, services and appearance.
        </DialogDescription>

        {isMobile ? (
          <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-sidebar px-2 py-2">
            {groups.flatMap(({ items }) =>
              items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => selectCategory(item.id)}
                  className={cn(
                    "shrink-0 rounded-md px-2.5 py-1.5 text-xs whitespace-nowrap",
                    item.id === category.id
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground"
                  )}
                >
                  {item.label}
                </button>
              ))
            )}
          </nav>
        ) : (
          <nav className="w-[13.5rem] shrink-0 overflow-y-auto border-r border-border bg-sidebar py-3">
            <p className="px-4 pb-2 text-sm font-semibold text-sidebar-foreground">
              Settings
            </p>
            {groups.map(({ group, items }) => (
              <div key={group} className="mb-1 px-2">
                <p className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-sidebar-foreground/50">
                  {group}
                </p>
                {items.map((item) => {
                  const Icon = item.icon
                  const active = item.id === category.id
                  return (
                    <button
                      key={item.id}
                      ref={active ? activeRailRef : undefined}
                      type="button"
                      onClick={() => selectCategory(item.id)}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                        active
                          ? "bg-sidebar-accent text-sidebar-accent-foreground"
                          : "text-sidebar-foreground/75 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground"
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 truncate">{item.label}</span>
                    </button>
                  )
                })}
              </div>
            ))}
          </nav>
        )}

        {/* The scroll lives on this element rather than on a nested `ScrollArea`.
            A flex item with `min-h-0` and its own `overflow-y-auto` takes a
            definite height from the row, so it needs no percentage height to
            resolve against — which is the same way the sidebar's conversation
            list already scrolls in this codebase. */}
        <div
          ref={paneRef}
          className="scrollbar-hover min-w-0 min-h-0 flex-1 overflow-y-auto"
        >
          {/* `pr-12` keeps the first row clear of the close button. Categories are
              keyed so switching remounts rather than reusing the previous one's
              state — two different two-pane browsers sharing a selection would be
              a bug, not a feature. */}
          <div key={category.id} className="space-y-6 px-6 pb-8 pt-5 pr-12">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              {category.label}
            </h2>
            {category.render()}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
