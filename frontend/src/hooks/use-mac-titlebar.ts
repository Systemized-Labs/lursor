import { useSidebar } from "@/components/ui/sidebar"
import { isMacElectron } from "@/lib/platform"

/**
 * What a surface at the top of the window owes the macOS traffic lights.
 *
 * On macOS the app is frameless, so the window buttons float over whatever is at
 * the top-left. AppSidebar turns that into a deliberate 44px chrome line across
 * the sidebar (`h-11`, with the buttons centred in it by `trafficLightPosition`
 * in electron/main.cjs) and puts the panel heading on the buttons' line.
 *
 * Anything else with a header row at the top of the window shares that line, so
 * it reads as one band rather than as two headers at two heights:
 *
 * - `enabled` — match the 44px line, so titles sit at the buttons' centre.
 * - `clearButtons` — *and* inset past the buttons themselves. Only when what is
 *   left of this surface is narrower than they are: the buttons end around x=84,
 *   so with the panel open (68 + 256) it starts far to their right and needs
 *   nothing, while rail-only it starts at 68 and a title would land underneath
 *   the green one. A labelled rail is 232px, which clears them by itself.
 */
export function useMacTitlebar() {
  const { isMobile, open, railWidth } = useSidebar()

  // Mobile is the off-canvas drawer over a full-width page, and never Electron —
  // no frameless chrome to work around.
  const enabled = isMacElectron && !isMobile

  return { enabled, clearButtons: enabled && !open && railWidth < 88 }
}
