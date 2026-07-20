/**
 * Per-line syntax highlighting for the Changes panel.
 *
 * Uses lowlight (the same highlight.js engine `rehype-highlight` drives for
 * markdown), so diff code shares the theme-aware `.hljs-*` token colors defined
 * in `index.css`. Each diff line is highlighted independently — block comments
 * and multi-line strings may colour imperfectly, the accepted trade-off for a
 * line-oriented diff view.
 */
import type { RootContent } from "hast"
import { common, createLowlight } from "lowlight"

const lowlight = createLowlight(common)

/** One highlighted slice of a line: its text and optional `hljs-*` class. */
export interface Token {
  text: string
  className?: string
}

// Filename extension → highlight.js language id. Anything not in `common`
// (guarded by `lowlight.registered`) falls back to no highlighting.
const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  swift: "swift",
  json: "json",
  html: "xml",
  htm: "xml",
  xml: "xml",
  vue: "xml",
  svelte: "xml",
  css: "css",
  scss: "scss",
  less: "less",
  md: "markdown",
  mdx: "markdown",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  ini: "ini",
}

/** Resolve a file path to a registered highlight.js language, or null. */
export function langFromPath(path: string): string | null {
  const lower = path.toLowerCase()
  const base = lower.slice(lower.lastIndexOf("/") + 1)
  if (base === "dockerfile") return lowlight.registered("dockerfile") ? "dockerfile" : null
  if (base === "makefile") return lowlight.registered("makefile") ? "makefile" : null
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : ""
  const lang = EXT_LANG[ext]
  return lang && lowlight.registered(lang) ? lang : null
}

/** Flatten a lowlight hast tree into a flat token list, carrying each token's
 *  nearest `hljs-*` class down to its text leaves. */
function flatten(
  nodes: RootContent[],
  inherited: string | undefined,
  out: Token[]
): void {
  for (const node of nodes) {
    if (node.type === "text") {
      out.push({ text: node.value, className: inherited })
    } else if (node.type === "element") {
      const raw = node.properties?.className
      const cls = Array.isArray(raw) ? raw.join(" ") : inherited
      flatten(node.children, cls, out)
    }
  }
}

/**
 * Highlight a single line of code. Returns a flat list of tokens whose text,
 * concatenated, equals `code` exactly (so callers can map word-diff char
 * offsets straight onto the tokens). Falls back to one plain token when the
 * language is unknown or highlighting fails.
 */
export function highlightLine(code: string, lang: string | null): Token[] {
  if (!lang || !code) return [{ text: code }]
  try {
    const tree = lowlight.highlight(lang, code)
    const tokens: Token[] = []
    flatten(tree.children, undefined, tokens)
    return tokens.length > 0 ? tokens : [{ text: code }]
  } catch {
    return [{ text: code }]
  }
}
