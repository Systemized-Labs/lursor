import { useEffect, useState } from 'react'
import { useTheme } from 'next-themes'
import { CaretUpDown, Check, Sun, Moon } from '@phosphor-icons/react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { THEME_OPTIONS, type ThemeOption } from '@/lib/themes'
import { cn } from '@/lib/utils'

/**
 * Theme selector — a compact dialog listing the available themes. Selecting a
 * theme applies it to the whole app in real time (via next-themes), so the live
 * site itself is the preview. A light/dark filter narrows the list.
 *
 * The small list swatches render real component markup scoped under the target
 * theme's CSS class (`light`/`dark`/color-theme name), so the theme's token
 * block cascades onto that subtree — an accurate swatch without activating it.
 */

/** Resolve the initial light/dark tab from the OS preference, defaulting to dark. */
function systemModeOrDark(): 'light' | 'dark' {
  if (typeof window !== 'undefined' && window.matchMedia) {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  }
  return 'dark'
}

/** Compact swatch shown in the list rows. */
function MiniMock() {
  return (
    <div className="flex h-9 w-12 shrink-0 overflow-hidden rounded border border-border bg-background">
      <div className="w-1/3 border-r border-border bg-sidebar" />
      <div className="flex flex-1 flex-col justify-between p-1">
        <div className="h-1 w-full rounded-full bg-primary" />
        <div className="flex gap-0.5">
          <span className="h-1.5 w-1.5 rounded-full bg-success" />
          <span className="h-1.5 w-1.5 rounded-full bg-warning" />
          <span className="h-1.5 w-1.5 rounded-full bg-info" />
          <span className="h-1.5 w-1.5 rounded-full bg-destructive" />
        </div>
      </div>
    </div>
  )
}

function ListSwatch({ value }: { value: string }) {
  if (value === 'system') {
    return (
      <div className="flex h-9 w-12 shrink-0 overflow-hidden rounded border border-border">
        <div className="light w-1/2 overflow-hidden border-r border-border bg-background">
          <div className="h-full w-full bg-sidebar/0 p-1">
            <div className="h-1 w-full rounded-full bg-primary" />
          </div>
        </div>
        <div className="dark w-1/2 overflow-hidden bg-background">
          <div className="h-full w-full p-1">
            <div className="h-1 w-full rounded-full bg-primary" />
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className={value}>
      <MiniMock />
    </div>
  )
}

export function ThemePicker({ trigger }: { trigger?: (open: () => void) => React.ReactNode }) {
  const { theme, setTheme } = useTheme()
  const [open, setOpen] = useState(false)
  const [modeFilter, setModeFilter] = useState<'light' | 'dark'>(systemModeOrDark)

  const active: ThemeOption | undefined = THEME_OPTIONS.find((t) => t.value === theme)

  // Filter by light/dark. Adaptive themes (no `mode`, e.g. System) always show.
  const visibleThemes = THEME_OPTIONS.filter(
    (t) => t.mode === undefined || t.mode === modeFilter,
  )

  const MODE_FILTERS = [
    { value: 'light', label: 'Light', icon: Sun },
    { value: 'dark', label: 'Dark', icon: Moon },
  ] as const

  function handleOpen() {
    setModeFilter(systemModeOrDark())
    setOpen(true)
  }

  // Arrow keys walk the visible list and apply each theme live; Enter confirms.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Enter') {
        e.preventDefault()
        setOpen(false)
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      if (visibleThemes.length === 0) return
      const cur = visibleThemes.findIndex((t) => t.value === theme)
      let next: number
      if (cur === -1) next = 0
      else next = e.key === 'ArrowDown' ? cur + 1 : cur - 1
      next = Math.max(0, Math.min(visibleThemes.length - 1, next))
      setTheme(visibleThemes[next].value)
    }
    // Capture phase so we intercept the key before the ScrollArea scrolls.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, visibleThemes, theme, setTheme])

  // Keep the active row scrolled into view as the selection moves.
  useEffect(() => {
    if (!open) return
    const el = document.querySelector(`[data-theme-row="${theme}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [open, theme])

  const ActiveIcon = active?.icon

  return (
    <>
      {trigger ? (
        trigger(handleOpen)
      ) : (
        <button
          type="button"
          onClick={handleOpen}
          className="flex h-9 min-h-[44px] md:min-h-0 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring"
        >
          <span className="flex items-center gap-2 truncate text-foreground">
            {ActiveIcon && <ActiveIcon className="h-4 w-4 shrink-0 text-muted-foreground" />}
            {active?.label ?? 'Select theme'}
          </span>
          <CaretUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="gap-0 overflow-hidden p-0 sm:max-w-md"
          overlayClassName="bg-transparent supports-backdrop-filter:backdrop-blur-none"
        >
          <DialogTitle className="sr-only">Select theme</DialogTitle>
          <div className="flex max-h-[74vh] min-h-0 flex-col">
            <div className="shrink-0 space-y-2.5 border-b border-border px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Theme</h2>
                <p className="text-xs text-muted-foreground">Pick a look — applies instantly</p>
              </div>
              {/* light/dark filter */}
              <div className="flex gap-1 rounded-md bg-muted/50 p-0.5">
                {MODE_FILTERS.map(({ value, label, icon: Icon }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setModeFilter(value)}
                    className={cn(
                      'flex flex-1 items-center justify-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors',
                      modeFilter === value
                        ? 'bg-background text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {Icon && <Icon className="h-3 w-3" />}
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="p-2">
                {visibleThemes.length === 0 && (
                  <p className="px-2 py-8 text-center text-sm text-muted-foreground">
                    No themes match this filter.
                  </p>
                )}
                {visibleThemes.map((opt) => {
                  const isSelected = opt.value === theme
                  const Icon = opt.icon
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      data-theme-row={opt.value}
                      onClick={() => setTheme(opt.value)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors',
                        isSelected ? 'bg-muted text-foreground' : 'text-foreground hover:bg-muted/60',
                      )}
                    >
                      <ListSwatch value={opt.value} />
                      <span className="flex min-w-0 flex-1 items-center gap-1.5">
                        {Icon && <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                        <span className="truncate text-sm">{opt.label}</span>
                      </span>
                      {isSelected && <Check className="h-4 w-4 shrink-0 text-primary" />}
                    </button>
                  )
                })}
              </div>
            </ScrollArea>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
