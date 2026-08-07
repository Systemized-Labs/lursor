import { useEffect, useRef, useState } from "react"
import { CaretLeft, CaretRight } from "@phosphor-icons/react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  categoryGroups,
  DEFAULT_CATEGORY,
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
 * One width, the widest one: 95vw up to 1400px. The two-pane browsers
 * (Capabilities, Environment, Schedules) need every pixel — the standalone pages
 * widened to `max-w-[100rem]` for exactly this reason — and sizing the rest
 * narrower meant the dialog jumped between two widths as you moved down the rail.
 * A modal that resizes under the cursor reads as a glitch, so the form and prose
 * categories take the wide frame too; capping their measure is their own job.
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
  /**
   * Phone only: whether a category has been picked.
   *
   * Starts true when the dialog is opened straight at a category — a deep link, or
   * the Capabilities nav row — because those name what you wanted, and landing on
   * a list you have to re-pick from would be asking twice.
   */
  const [mobileDrilled, setMobileDrilled] = useState(
    () => categoryId !== null && categoryId !== DEFAULT_CATEGORY
  )
  useEffect(() => {
    if (!open) setMobileDrilled(false)
  }, [open])

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
          "flex h-[86vh] max-h-[860px] w-[95vw] max-w-[1400px] gap-0 overflow-hidden p-0",
          // The rail stacks above the pane on a phone; below `md` there is not
          // enough width for a column of category names beside content.
          isMobile &&
            "h-[92dvh] max-h-none w-screen max-w-none flex-col rounded-none"
        )}
      >
        {/* The dialog names itself for screen readers; the visible heading is the
            active category's own, on the pane. */}
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          Configure agents, model providers, services and appearance.
        </DialogDescription>

        {isMobile ? (
          /* Two levels, not a chip strip.
             A phone cannot hold a category rail beside content, and a horizontal
             row of fourteen chips is a thing you scroll past rather than read —
             it hides the grouping and makes the current category one of fourteen
             equal-weight scraps. So: the list *is* the screen until you pick
             something, then the category fills it with a row back. That is the
             platform convention for settings on a phone, and it costs one tap
             rather than a horizontal hunt. */
          <nav
            className={cn(
              "min-h-0 flex-1 overflow-y-auto bg-sidebar py-2",
              mobileDrilled && "hidden"
            )}
          >
            {groups.map(({ group, items }) => (
              <div key={group} className="mb-1 px-2">
                <p className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-sidebar-foreground/50">
                  {group}
                </p>
                {items.map((item) => {
                  const Icon = item.icon
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        selectCategory(item.id)
                        setMobileDrilled(true)
                      }}
                      className="flex w-full items-center gap-2.5 rounded-md px-2 py-2.5 text-left text-sm text-sidebar-foreground hover:bg-sidebar-accent"
                    >
                      <Icon className="size-4 shrink-0 text-sidebar-foreground/70" />
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      <CaretRight className="size-3.5 shrink-0 text-sidebar-foreground/40" />
                    </button>
                  )
                })}
              </div>
            ))}
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
          className={cn(
            "scrollbar-hover min-w-0 min-h-0 flex-1 overflow-y-auto",
            isMobile && !mobileDrilled && "hidden"
          )}
        >
          {isMobile ? (
            <button
              type="button"
              onClick={() => setMobileDrilled(false)}
              className="sticky top-0 z-10 flex w-full items-center gap-1.5 border-b border-border bg-popover px-3 py-2 text-left text-sm text-muted-foreground"
            >
              <CaretLeft className="size-4 shrink-0" />
              Settings
            </button>
          ) : null}
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
