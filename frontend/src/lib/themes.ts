import type { ElementType } from 'react'
import {
  Sun,
  Moon,
  Monitor,
  Waves,
  Sunset,
  Terminal,
  SquareTerminal,
  Sparkles,
  Coffee,
  Ghost,
  Map,
  Star,
  Droplet,
  Binary,
  Palette,
  Radiation,
  FlaskConical,
  Box,
  Zap,
  Flame,
  Lightbulb,
  Sparkle,
  Flower2,
  Sunrise,
  Cloud,
  Citrus,
  Type,
  BookOpen,
  Bird,
  Square,
  MessageSquare,
  Gem,
  Skull,
  Trees,
  Telescope,
  Cpu,
  Crown,
  Hammer,
  Eraser,
  Wind,
  Gamepad2,
  Mountain,
  ScrollText,
  Stars,
  Heart,
  Leaf,
  Cherry,
  Castle,
  Snowflake,
  Flower,
  Hexagon,
  Shell,
  FileText,
  CakeSlice,
  GlassWater,
  Clock,
  Diamond,
  Anchor,
  Thermometer,
  Music,
  Building2,
  TreePine,
  Orbit,
  Shield,
  Eye,
  CircleDot,
  Sailboat,
  Sprout,
  Feather,
  Paintbrush,
} from 'lucide-react'

/**
 * Theme registry — single source of truth for theme switching.
 *
 * next-themes owns the active theme end-to-end: persistence (localStorage), a
 * no-flash inline script that sets the class before first paint, and applying
 * the class to `<html>`. We use `attribute="class"`, so the active theme name
 * becomes a class on `<html>`:
 *   - `light`  → the base `:root` token values (no extra rule needed)
 *   - `dark`   → the `.dark` token block (also drives Tailwind's `dark:` variant)
 *   - `system` → follows the OS, resolving to `light`/`dark` (via `enableSystem`)
 *   - any color theme → its own `.<value>` token block in `globals.css`
 *
 * Adding a color theme = one entry in {@link COLOR_THEMES} + one `.<value> { … }`
 * block in `globals.css` defining the full token set. Zero component changes.
 *
 * NOTE: a color theme is a *complete, standalone* token set — it is not layered
 * on top of light/dark. Tailwind's `dark:` variant only fires under the literal
 * `.dark` class, so a dark-styled color theme must bake its values directly into
 * its own block rather than rely on `dark:` utilities.
 */
export interface ThemeOption {
  /** Identifier; also the class next-themes applies to `<html>`. */
  value: string
  label: string
  icon?: ElementType
  /**
   * Whether the theme reads as light or dark — used only to filter the picker.
   * `undefined` means it adapts (e.g. `system`) and shows under every filter.
   */
  mode?: 'light' | 'dark'
}

/** Built-in light / dark / system modes (handled natively by next-themes). */
export const MODE_THEMES: ThemeOption[] = [
  { value: 'light', label: 'Light', icon: Sun, mode: 'light' },
  { value: 'dark', label: 'Dark', icon: Moon, mode: 'dark' },
  { value: 'system', label: 'System', icon: Monitor },
]

/**
 * Additional color themes. Each entry needs a matching complete `.<value> { … }`
 * token block in `globals.css`. These two are starter examples — replace or
 * extend them.
 */
export const COLOR_THEMES: ThemeOption[] = [
  { value: 'ocean', label: 'Ocean', icon: Waves, mode: 'light' },
  { value: 'sunset', label: 'Sunset', icon: Sunset, mode: 'light' },
  { value: 'terminal', label: 'Terminal', icon: Terminal, mode: 'dark' },
  { value: 'terminal-light', label: 'Terminal Light', icon: Terminal, mode: 'light' },
  { value: 'crimson', label: 'Crimson', icon: SquareTerminal, mode: 'dark' },
  { value: 'crimson-light', label: 'Crimson Light', icon: SquareTerminal, mode: 'light' },
  { value: 'claude', label: 'Claude', icon: Sparkles, mode: 'light' },
  { value: 'claude-blue', label: 'Claude Blue', icon: Droplet, mode: 'dark' },
  { value: 'frappe', label: 'Frappé', icon: Coffee, mode: 'dark' },
  { value: 'dracula', label: 'Dracula', icon: Ghost, mode: 'dark' },
  { value: 'ilumap', label: 'Ilumap', icon: Map, mode: 'light' },
  { value: 'astra', label: 'Astra', icon: Star, mode: 'dark' },
  { value: 'matrix', label: 'Matrix', icon: Binary, mode: 'dark' },
  { value: 'coral', label: 'Coral', icon: Palette, mode: 'light' },
  { value: 'fallout', label: 'Fallout', icon: Radiation, mode: 'dark' },
  { value: 'fallout-light', label: 'Fallout Light', icon: Radiation, mode: 'light' },
  { value: 'styrene', label: 'Styrene', icon: FlaskConical, mode: 'dark' },
  { value: 'gruvbox', label: 'Gruvbox', icon: Box, mode: 'dark' },
  { value: 'cyberpunk', label: 'Cyberpunk', icon: Zap, mode: 'dark' },
  { value: 'lobster', label: 'Lobster', icon: Flame, mode: 'dark' },
  { value: 'amber', label: 'Amber', icon: Lightbulb, mode: 'dark' },
  { value: 'stella', label: 'Stella', icon: Sparkle, mode: 'dark' },
  { value: 'rose', label: 'Rose', icon: Flower2, mode: 'light' },
  { value: 'solstice', label: 'Solstice', icon: Sunrise, mode: 'dark' },
  { value: 'azure', label: 'Azure', icon: Cloud, mode: 'light' },
  { value: 'tangerine', label: 'Tangerine', icon: Citrus, mode: 'light' },
  { value: 'swiss', label: 'Swiss', icon: Type, mode: 'light' },
  { value: 'coffee', label: 'Coffee', icon: BookOpen, mode: 'light' },
  { value: 'ember', label: 'Ember', icon: Flame, mode: 'dark' },
  { value: 'twitter', label: 'Twitter', icon: Bird, mode: 'light' },
  { value: 'modern-minimal', label: 'Modern Minimal', icon: Square, mode: 'light' },
  { value: 'violet-bloom', label: 'Violet Bloom', icon: Flower2, mode: 'light' },
  { value: 't3-chat', label: 'T3 Chat', icon: MessageSquare, mode: 'dark' },
  { value: 'mocha-mousse', label: 'Mocha Mousse', icon: Coffee, mode: 'light' },
  { value: 'amethyst-haze', label: 'Amethyst Haze', icon: Gem, mode: 'light' },
  { value: 'doom-64', label: 'Doom 64', icon: Skull, mode: 'dark' },
  { value: 'kodama-grove', label: 'Kodama Grove', icon: Trees, mode: 'light' },
  { value: 'cosmic-night', label: 'Cosmic Night', icon: Telescope, mode: 'dark' },
  { value: 'quantum-rose', label: 'Quantum Rose', icon: Sparkles, mode: 'dark' },
  { value: 'bold-tech', label: 'Bold Tech', icon: Cpu, mode: 'dark' },
  { value: 'elegant-luxury', label: 'Elegant Luxury', icon: Crown, mode: 'dark' },
  { value: 'amber-minimal', label: 'Amber Minimal', icon: Sun, mode: 'light' },
  { value: 'neo-brutalism', label: 'Neo Brutalism', icon: Hammer, mode: 'light' },
  { value: 'solar-dusk', label: 'Solar Dusk', icon: Sunset, mode: 'dark' },
  { value: 'pastel-dreams', label: 'Pastel Dreams', icon: Palette, mode: 'light' },
  { value: 'clean-slate', label: 'Clean Slate', icon: Eraser, mode: 'light' },
  { value: 'ocean-breeze', label: 'Ocean Breeze', icon: Wind, mode: 'light' },
  { value: 'retro-arcade', label: 'Retro Arcade', icon: Gamepad2, mode: 'dark' },
  { value: 'midnight-bloom', label: 'Midnight Bloom', icon: Moon, mode: 'dark' },
  { value: 'northern-lights', label: 'Northern Lights', icon: Mountain, mode: 'dark' },
  { value: 'vintage-paper', label: 'Vintage Paper', icon: ScrollText, mode: 'light' },
  { value: 'sunset-horizon', label: 'Sunset Horizon', icon: Sunrise, mode: 'light' },
  { value: 'starry-night', label: 'Starry Night', icon: Stars, mode: 'dark' },
  { value: 'soft-pop', label: 'Soft Pop', icon: Heart, mode: 'light' },
  { value: 'sage-garden', label: 'Sage Garden', icon: Leaf, mode: 'light' },
  { value: 'cherry-blossom', label: 'Cherry Blossom', icon: Cherry, mode: 'light' },
  { value: 'sandstone', label: 'Sandstone', icon: Castle, mode: 'light' },
  { value: 'arctic', label: 'Arctic', icon: Snowflake, mode: 'light' },
  { value: 'lavender-fields', label: 'Lavender Fields', icon: Flower, mode: 'light' },
  { value: 'honeycomb', label: 'Honeycomb', icon: Hexagon, mode: 'light' },
  { value: 'seafoam', label: 'Seafoam', icon: Shell, mode: 'light' },
  { value: 'parchment', label: 'Parchment', icon: FileText, mode: 'light' },
  { value: 'peach-cream', label: 'Peach Cream', icon: CakeSlice, mode: 'light' },
  { value: 'mint-julep', label: 'Mint Julep', icon: GlassWater, mode: 'light' },
  { value: 'golden-hour', label: 'Golden Hour', icon: Clock, mode: 'light' },
  { value: 'obsidian', label: 'Obsidian', icon: Diamond, mode: 'dark' },
  { value: 'deep-sea', label: 'Deep Sea', icon: Anchor, mode: 'dark' },
  { value: 'volcanic', label: 'Volcanic', icon: Thermometer, mode: 'dark' },
  { value: 'midnight-jazz', label: 'Midnight Jazz', icon: Music, mode: 'dark' },
  { value: 'charcoal', label: 'Charcoal', icon: Building2, mode: 'dark' },
  { value: 'forest-night', label: 'Forest Night', icon: TreePine, mode: 'dark' },
  { value: 'nebula', label: 'Nebula', icon: Orbit, mode: 'dark' },
  { value: 'onyx', label: 'Onyx', icon: Shield, mode: 'dark' },
  { value: 'phantom', label: 'Phantom', icon: Eye, mode: 'dark' },
  { value: 'blood-moon', label: 'Blood Moon', icon: CircleDot, mode: 'dark' },
  { value: 'tokyo-neon', label: 'Tokyo Neon', icon: Building2, mode: 'dark' },
  { value: 'velvet-dusk', label: 'Velvet Dusk', icon: Gem, mode: 'dark' },
  { value: 'aurora', label: 'Aurora', icon: Stars, mode: 'dark' },
  { value: 'speakeasy', label: 'Speakeasy', icon: GlassWater, mode: 'dark' },
  { value: 'graphite', label: 'Graphite', icon: Square, mode: 'dark' },
  { value: 'santorini', label: 'Santorini', icon: Sailboat, mode: 'light' },
  { value: 'bamboo', label: 'Bamboo', icon: Sprout, mode: 'light' },
  { value: 'porcelain', label: 'Porcelain', icon: Feather, mode: 'light' },
  { value: 'terracotta', label: 'Terracotta', icon: Paintbrush, mode: 'light' },
  { value: 'juniper', label: 'Juniper', icon: Leaf, mode: 'light' },
]

/** Concrete theme names next-themes manages (excludes the `system` mode). */
export const THEME_NAMES: string[] = ['light', 'dark', ...COLOR_THEMES.map((t) => t.value)]

/** Everything shown in the Settings theme picker (modes + color themes). */
export const THEME_OPTIONS: ThemeOption[] = [...MODE_THEMES, ...COLOR_THEMES]
