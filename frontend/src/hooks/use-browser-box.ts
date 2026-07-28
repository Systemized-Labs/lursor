import { useEffect, useState } from "react"

/**
 * Narrowest container that can hold two panes: below it the rail takes the full
 * width and the detail side arrives as a sheet.
 *
 * Measured on the container rather than the viewport, because the app sidebar
 * takes its cut before a page sees any width — a 768px window with the sidebar
 * open leaves ~470px there, which is a phone's worth of room.
 */
const TWO_PANE_MIN_WIDTH = 720

/** Breathing room below the browser, so it doesn't sit flush to the fold. */
const BOTTOM_GUTTER = 24

/** Floor, for a window too short to honour the measurement. */
const MIN_HEIGHT = 280

export interface BrowserBox {
  /** Pixels, so the box ends just above the fold whatever sits above it. */
  height: number
  narrow: boolean
}

function measureBox(el: HTMLElement): BrowserBox {
  const rect = el.getBoundingClientRect()
  return {
    height: Math.max(MIN_HEIGHT, window.innerHeight - rect.top - BOTTOM_GUTTER),
    narrow: rect.width < TWO_PANE_MIN_WIDTH,
  }
}

/**
 * How tall a two-pane browser should be, and whether it gets two panes.
 *
 * These pages sit in a padded, scrolling column with no definite height, so the
 * two panes can't just be `flex-1` — the box needs a real height to scroll its
 * halves independently. That used to be a `calc(100svh - Nrem)` with `N`
 * measured by hand, which breaks the moment anything above changes height: the
 * Customization tab strip wraps onto a second row at some widths, moving the box
 * 50px down. So measure the gap to the fold instead of encoding it.
 *
 * Pass a ref to an element that is always mounted and always the full width the
 * page has to work with — not one that unmounts while loading.
 */
export function useBrowserBox(
  ref: React.RefObject<HTMLDivElement | null>
): BrowserBox {
  const [box, setBox] = useState<BrowserBox>({
    height: MIN_HEIGHT,
    narrow: false,
  })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const next = measureBox(el)
      // Bail on an unchanged result: this observes the element whose height it
      // sets, so a new object every time would loop.
      setBox((prev) =>
        prev.height === next.height && prev.narrow === next.narrow ? prev : next
      )
    }
    // Width changes reach us through the observer (the sidebar collapsing, the
    // window resizing); `resize` also covers a height-only window change, which
    // moves the fold without resizing anything here.
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    window.addEventListener("resize", measure)
    measure()
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", measure)
    }
  }, [ref])
  return box
}
