/**
 * Derive a Monaco color theme from the app's active CSS theme.
 *
 * The app has ~80 themes, each applied as its own class on `<html>` (e.g.
 * `.dark`, `.dracula`, `.matrix`) with a complete token set in `index.css`.
 * Monaco can't read CSS custom properties, and it only ships `vs` / `vs-dark`,
 * so keying off the `.dark` class alone leaves every non-`.dark` dark theme
 * rendering in light mode.
 *
 * Instead we read the resolved token values off `<html>` at runtime, convert
 * them to the `#rrggbb` hex Monaco requires, and register a single theme that
 * mirrors the active app theme. Re-run {@link defineMonacoTheme} whenever the
 * theme class changes to keep them in sync.
 */
import type * as Monaco from "monaco-editor"

/** Name of the theme we register with Monaco. */
export const MONACO_THEME_NAME = "app"

/**
 * A 1×1 canvas used to rasterise arbitrary CSS colors to sRGB. Using a canvas
 * (rather than getComputedStyle) is robust across color formats: modern
 * browsers serialise a computed `oklch(…)` color back as `oklch(…)`, but the
 * canvas always resolves to concrete rgb pixels.
 */
let ctx: CanvasRenderingContext2D | null = null

/** Resolve a CSS color string (any format) to `#rrggbb`, or null if unparseable. */
function colorToHex(cssColor: string): string | null {
  if (!cssColor) return null
  if (!ctx) {
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 1
    ctx = canvas.getContext("2d")
  }
  if (!ctx) return null
  // Reset to a known value so an invalid `cssColor` (ignored by the setter)
  // can't leak a previous color through.
  ctx.fillStyle = "#000000"
  ctx.fillStyle = cssColor
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return (
    "#" +
    [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")
  )
}

/** Read a CSS custom property off `<html>` and resolve it to hex. */
function tokenHex(name: string, fallback: string): string {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim()
  return colorToHex(raw) ?? fallback
}

/** Perceived luminance (0–1) of a `#rrggbb` color, for light/dark detection. */
function luminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * Register (or update) the `app` Monaco theme from the current CSS theme, then
 * return its name so the caller can activate it. Inherits `vs` / `vs-dark`
 * syntax token colors depending on the resolved background luminance.
 */
export function defineMonacoTheme(monaco: typeof Monaco): string {
  const background = tokenHex("--background", "#ffffff")
  const foreground = tokenHex("--foreground", "#000000")
  const muted = tokenHex("--muted-foreground", "#888888")
  const accent = tokenHex("--accent", "#dddddd")
  const border = tokenHex("--border", "#e5e5e5")
  const primary = tokenHex("--primary", foreground)

  const isDark = luminance(background) < 0.5

  monaco.editor.defineTheme(MONACO_THEME_NAME, {
    base: isDark ? "vs-dark" : "vs",
    inherit: true,
    rules: [{ token: "", foreground: foreground.slice(1), background: background.slice(1) }],
    colors: {
      "editor.background": background,
      "editor.foreground": foreground,
      "editorLineNumber.foreground": muted,
      "editorLineNumber.activeForeground": foreground,
      "editorCursor.foreground": primary,
      // Alpha-blended so text underneath stays legible.
      "editor.selectionBackground": accent + "99",
      "editor.lineHighlightBackground": accent + "66",
      "editorIndentGuide.background": border,
      "editorIndentGuide.activeBackground": muted,
      "editorWhitespace.foreground": border,
      "editorGutter.background": background,
      "editorWidget.background": background,
      "editorWidget.border": border,
      "input.background": background,
      "dropdown.background": background,
    },
  })

  return MONACO_THEME_NAME
}
