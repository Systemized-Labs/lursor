/** One `KEY=value` pair lifted out of pasted `.env` text. */
export interface DotEnvEntry {
  key: string
  value: string
}

/** What the backend accepts as a variable name, and what a shell can export. */
const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Parse pasted `.env` text into key/value pairs.
 *
 * Deliberately a small subset of what dotenv implementations support — enough for
 * a file a person actually has on disk, and nothing that guesses. Handled:
 * comments, blank lines, an `export ` prefix, surrounding single or double
 * quotes, `\n`/`\t`/`\"` escapes inside double quotes (single quotes stay
 * literal, as in a shell), and a trailing `# comment` after an unquoted value.
 *
 * Not handled, on purpose: multi-line values and `${VAR}` interpolation. Both need
 * a real parser to get right, and getting them subtly wrong writes a broken
 * credential into the database — a line this skips is visible in the preview and
 * can be added by hand, which a mangled one is not.
 */
export function parseDotEnv(text: string): DotEnvEntry[] {
  const out: DotEnvEntry[] = []
  const seen = new Set<string>()

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue

    const withoutExport = line.startsWith("export ")
      ? line.slice("export ".length).trim()
      : line
    const eq = withoutExport.indexOf("=")
    if (eq <= 0) continue

    const key = withoutExport.slice(0, eq).trim()
    if (!VALID_KEY.test(key)) continue

    let value = withoutExport.slice(eq + 1).trim()
    if (value.length >= 2 && value[0] === '"' && value.endsWith('"')) {
      value = value
        .slice(1, -1)
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\")
    } else if (value.length >= 2 && value[0] === "'" && value.endsWith("'")) {
      value = value.slice(1, -1)
    } else {
      // An unquoted value ends at the first ` #`. Without the leading space a
      // perfectly good `pass#word` would be truncated.
      const comment = value.indexOf(" #")
      if (comment >= 0) value = value.slice(0, comment).trimEnd()
    }

    // Last one wins, matching how a shell sources the file, but keep the original
    // position so the preview reads in file order.
    if (seen.has(key)) {
      const at = out.findIndex((entry) => entry.key === key)
      out[at] = { key, value }
      continue
    }
    seen.add(key)
    out.push({ key, value })
  }

  return out
}
