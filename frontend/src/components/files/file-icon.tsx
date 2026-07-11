import type { ElementType } from "react"
import {
  BracketsCurly,
  Database,
  File,
  FileCode,
  FileText,
  FileHtml,
  Hash,
  Image,
  Lock,
  Palette,
  GearSix,
  Terminal,
} from "@phosphor-icons/react"

/**
 * Map a filename to a glyph and a short language label.
 *
 * Files are told apart by icon *shape*, not color — so the tree reads clearly
 * under every theme without leaning on hard-coded hues. The label is the
 * human name for the language (shown in the editor header), distinct from the
 * Monaco language id in {@link languageForFilename}.
 */
interface FileKind {
  Icon: ElementType
  label: string
}

const EXT_KINDS: Record<string, FileKind> = {
  ts: { Icon: FileCode, label: "TypeScript" },
  tsx: { Icon: FileCode, label: "TypeScript" },
  js: { Icon: FileCode, label: "JavaScript" },
  jsx: { Icon: FileCode, label: "JavaScript" },
  mjs: { Icon: FileCode, label: "JavaScript" },
  cjs: { Icon: FileCode, label: "JavaScript" },
  py: { Icon: FileCode, label: "Python" },
  rb: { Icon: FileCode, label: "Ruby" },
  go: { Icon: FileCode, label: "Go" },
  rs: { Icon: FileCode, label: "Rust" },
  java: { Icon: FileCode, label: "Java" },
  kt: { Icon: FileCode, label: "Kotlin" },
  c: { Icon: FileCode, label: "C" },
  h: { Icon: FileCode, label: "C" },
  cpp: { Icon: FileCode, label: "C++" },
  cc: { Icon: FileCode, label: "C++" },
  hpp: { Icon: FileCode, label: "C++" },
  cs: { Icon: FileCode, label: "C#" },
  php: { Icon: FileCode, label: "PHP" },
  swift: { Icon: FileCode, label: "Swift" },
  vue: { Icon: FileCode, label: "Vue" },
  svelte: { Icon: FileCode, label: "Svelte" },
  json: { Icon: BracketsCurly, label: "JSON" },
  html: { Icon: FileHtml, label: "HTML" },
  htm: { Icon: FileHtml, label: "HTML" },
  xml: { Icon: FileHtml, label: "XML" },
  css: { Icon: Palette, label: "CSS" },
  scss: { Icon: Palette, label: "Sass" },
  less: { Icon: Palette, label: "Less" },
  md: { Icon: Hash, label: "Markdown" },
  mdx: { Icon: Hash, label: "MDX" },
  txt: { Icon: FileText, label: "Text" },
  sh: { Icon: Terminal, label: "Shell" },
  bash: { Icon: Terminal, label: "Shell" },
  zsh: { Icon: Terminal, label: "Shell" },
  sql: { Icon: Database, label: "SQL" },
  yml: { Icon: GearSix, label: "YAML" },
  yaml: { Icon: GearSix, label: "YAML" },
  toml: { Icon: GearSix, label: "TOML" },
  ini: { Icon: GearSix, label: "INI" },
  env: { Icon: GearSix, label: "Env" },
  lock: { Icon: Lock, label: "Lockfile" },
  png: { Icon: Image, label: "Image" },
  jpg: { Icon: Image, label: "Image" },
  jpeg: { Icon: Image, label: "Image" },
  gif: { Icon: Image, label: "Image" },
  svg: { Icon: Image, label: "SVG" },
  webp: { Icon: Image, label: "Image" },
  ico: { Icon: Image, label: "Icon" },
}

const NAME_KINDS: Record<string, FileKind> = {
  dockerfile: { Icon: Terminal, label: "Dockerfile" },
  makefile: { Icon: Terminal, label: "Makefile" },
  ".gitignore": { Icon: GearSix, label: "Git ignore" },
  ".env": { Icon: GearSix, label: "Env" },
}

/** Resolve a filename to its glyph + language label. */
export function fileKind(name: string): FileKind {
  const lower = name.toLowerCase()
  if (lower in NAME_KINDS) return NAME_KINDS[lower]
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : ""
  return EXT_KINDS[ext] ?? { Icon: File, label: "Plain text" }
}
