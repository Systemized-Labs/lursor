/**
 * Appearance registry — user-selectable font family and size.
 *
 * These live alongside the theme (see {@link file://./themes.ts}) but are
 * managed by us rather than next-themes. Both settings persist to
 * `localStorage` and are applied by setting inline custom properties on
 * `<html>`:
 *   - font family → overrides `--font-sans` (the token Tailwind's base layer
 *     and every `font-sans` utility resolve to), so it cascades app-wide.
 *   - font size   → sets the root `font-size` (px), scaling every rem-based size.
 *
 * A tiny inline script in `index.html` applies the stored values before first
 * paint to avoid a flash; keep that script in sync with the maps below.
 *
 * Non-system families (Inter, JetBrains Mono, …) are loaded from Google Fonts
 * via `<link>`s in `index.html`; keep those in sync when adding entries here.
 */

export const FONT_FAMILY_STORAGE_KEY = "lursor-font-family"
export const FONT_SIZE_STORAGE_KEY = "lursor-font-size"

/** Broad buckets used to group the family picker. */
export type FontCategory = "Sans-serif" | "Serif" | "Monospace"

export interface FontFamilyOption {
  /** Identifier persisted to localStorage. */
  value: string
  label: string
  category: FontCategory
  /** The CSS `font-family` stack applied to `--font-sans`. */
  stack: string
}

/** The built-in stack (mirrors `--font-sans` in index.css). */
export const DEFAULT_FONT_STACK =
  '"Geist Pixel", "Geist Variable", ui-sans-serif, system-ui, sans-serif'

const sans = (value: string, label: string, primary: string): FontFamilyOption => ({
  value,
  label,
  category: "Sans-serif",
  stack: `"${primary}", ui-sans-serif, system-ui, sans-serif`,
})
const serif = (value: string, label: string, primary: string): FontFamilyOption => ({
  value,
  label,
  category: "Serif",
  stack: `"${primary}", Georgia, Cambria, "Times New Roman", serif`,
})
const mono = (value: string, label: string, primary: string): FontFamilyOption => ({
  value,
  label,
  category: "Monospace",
  stack: `"${primary}", ui-monospace, SFMono-Regular, Menlo, monospace`,
})

export const FONT_FAMILIES: FontFamilyOption[] = [
  // ── Sans-serif ──────────────────────────────────────────────────────────
  {
    value: "default",
    label: "Default (Geist)",
    category: "Sans-serif",
    stack: DEFAULT_FONT_STACK,
  },
  {
    value: "geist",
    label: "Geist Sans",
    category: "Sans-serif",
    stack: '"Geist Variable", ui-sans-serif, system-ui, sans-serif',
  },
  sans("inter", "Inter", "Inter"),
  sans("geist-google", "Geist", "Geist"),
  sans("space-grotesk", "Space Grotesk", "Space Grotesk"),
  sans("sora", "Sora", "Sora"),
  sans("outfit", "Outfit", "Outfit"),
  sans("lexend", "Lexend", "Lexend"),
  sans("manrope", "Manrope", "Manrope"),
  sans("dm-sans", "DM Sans", "DM Sans"),
  sans("plus-jakarta", "Plus Jakarta Sans", "Plus Jakarta Sans"),
  sans("ibm-plex-sans", "IBM Plex Sans", "IBM Plex Sans"),
  sans("poppins", "Poppins", "Poppins"),
  sans("figtree", "Figtree", "Figtree"),
  {
    value: "system",
    label: "System UI",
    category: "Sans-serif",
    stack:
      'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  },
  // ── Serif ───────────────────────────────────────────────────────────────
  serif("instrument-serif", "Instrument Serif", "Instrument Serif"),
  serif("playfair", "Playfair Display", "Playfair Display"),
  serif("fraunces", "Fraunces", "Fraunces"),
  serif("lora", "Lora", "Lora"),
  serif("source-serif", "Source Serif 4", "Source Serif 4"),
  serif("ibm-plex-serif", "IBM Plex Serif", "IBM Plex Serif"),
  {
    value: "georgia",
    label: "Georgia",
    category: "Serif",
    stack: 'Georgia, Cambria, "Times New Roman", Times, serif',
  },
  // ── Monospace ─────────────────────────────────────────────────────────────
  mono("jetbrains-mono", "JetBrains Mono", "JetBrains Mono"),
  mono("fira-code", "Fira Code", "Fira Code"),
  mono("space-mono", "Space Mono", "Space Mono"),
  mono("ibm-plex-mono", "IBM Plex Mono", "IBM Plex Mono"),
  mono("geist-mono", "Geist Mono", "Geist Mono"),
  mono("victor-mono", "Victor Mono", "Victor Mono"),
  {
    value: "mono",
    label: "System Mono",
    category: "Monospace",
    stack:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  },
]

/** Family categories, in display order. */
export const FONT_CATEGORIES: FontCategory[] = ["Sans-serif", "Serif", "Monospace"]

export const DEFAULT_FONT_FAMILY = "default"

// ── Font size ───────────────────────────────────────────────────────────────
// Root `font-size` in px; scales all rem-based sizing. Presented as a dropdown
// of preset px values, but stored as a raw number so it stays flexible.
export const FONT_SIZES: number[] = [12, 13, 14, 15, 16, 17, 18, 20, 22, 24]
export const DEFAULT_FONT_SIZE = 16
export const MIN_FONT_SIZE = FONT_SIZES[0]
export const MAX_FONT_SIZE = FONT_SIZES[FONT_SIZES.length - 1]

function resolveFamily(value: string): FontFamilyOption {
  return FONT_FAMILIES.find((f) => f.value === value) ?? FONT_FAMILIES[0]
}

/** Clamp an arbitrary px value into the supported range. */
export function clampFontSize(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_FONT_SIZE
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(px)))
}

/** Read the persisted font family, falling back to the default. */
export function getStoredFontFamily(): string {
  if (typeof localStorage === "undefined") return DEFAULT_FONT_FAMILY
  const stored = localStorage.getItem(FONT_FAMILY_STORAGE_KEY)
  return stored && FONT_FAMILIES.some((f) => f.value === stored)
    ? stored
    : DEFAULT_FONT_FAMILY
}

/**
 * Read the persisted font size (px), falling back to the default. Also maps the
 * legacy preset keys (`sm`/`md`/`lg`/`xl`) so earlier settings survive.
 */
export function getStoredFontSize(): number {
  if (typeof localStorage === "undefined") return DEFAULT_FONT_SIZE
  const stored = localStorage.getItem(FONT_SIZE_STORAGE_KEY)
  if (!stored) return DEFAULT_FONT_SIZE
  const legacy: Record<string, number> = { sm: 14, md: 16, lg: 18, xl: 20 }
  if (stored in legacy) return legacy[stored]
  return clampFontSize(Number(stored))
}

/** Apply a font family to `<html>` (overrides `--font-sans`). */
export function applyFontFamily(value: string) {
  if (typeof document === "undefined") return
  document.documentElement.style.setProperty("--font-sans", resolveFamily(value).stack)
}

/** Apply a font size to `<html>` (sets the root `font-size`). */
export function applyFontSize(px: number) {
  if (typeof document === "undefined") return
  document.documentElement.style.fontSize = `${clampFontSize(px)}px`
}
