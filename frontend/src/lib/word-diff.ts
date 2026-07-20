/**
 * Token-level intra-line diff for the Changes panel.
 *
 * Given the old and new text of a modified line (a `-`/`+` pair), computes the
 * character ranges that actually changed on each side — so the panel can
 * bright-highlight just the edited tokens instead of tinting the whole line,
 * matching a GitHub/Cursor word-diff.
 */

/** A half-open character range `[start, end)` within a line's text. */
export interface Range {
  start: number
  end: number
}

// One token = a whitespace run, an identifier/number run, or a single other
// char. Splitting on identifier boundaries keeps word-level edits crisp while
// still catching single-character punctuation changes.
const TOKEN_RE = /\s+|[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]/g

interface Token {
  text: string
  start: number
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  let match: RegExpExecArray | null
  TOKEN_RE.lastIndex = 0
  while ((match = TOKEN_RE.exec(text)) !== null) {
    tokens.push({ text: match[0], start: match.index })
  }
  return tokens
}

/** Append `[start, end)`, merging into the previous range when adjacent. */
function push(ranges: Range[], start: number, end: number): void {
  if (end <= start) return
  const last = ranges[ranges.length - 1]
  if (last && last.end === start) last.end = end
  else ranges.push({ start, end })
}

// Below this token-overlap ratio the two lines aren't really the same line
// edited — they're unrelated. Emphasizing every token then reads as noise, so
// we fall back to a plain whole-line tint (no word ranges). Whitespace tokens
// are excluded from the ratio: they match between any two indented lines and
// would otherwise make unrelated lines look similar.
const MIN_SIMILARITY = 0.25

const isWhitespace = (text: string): boolean => /^\s+$/.test(text)

/**
 * Diff two line strings at the token level. Returns the changed character
 * ranges on the old (`del`) and new (`add`) side. Returns empty ranges when
 * the lines are too dissimilar to be a meaningful word-diff.
 */
export function wordDiff(
  oldText: string,
  newText: string
): { del: Range[]; add: Range[] } {
  const a = tokenize(oldText)
  const b = tokenize(newText)
  const n = a.length
  const m = b.length
  const empty = { del: [], add: [] }
  if (n === 0 || m === 0) return empty

  // Longest-common-subsequence table over tokens (lines are short, so the
  // O(n*m) table is cheap). dp[i][j] = LCS length of a[i:] and b[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  )
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i].text === b[j].text
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const del: Range[] = []
  const add: Range[] = []
  let i = 0
  let j = 0
  let matchedNonWs = 0
  while (i < n && j < m) {
    if (a[i].text === b[j].text) {
      if (!isWhitespace(a[i].text)) matchedNonWs++
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push(del, a[i].start, a[i].start + a[i].text.length)
      i++
    } else {
      push(add, b[j].start, b[j].start + b[j].text.length)
      j++
    }
  }
  for (; i < n; i++) push(del, a[i].start, a[i].start + a[i].text.length)
  for (; j < m; j++) push(add, b[j].start, b[j].start + b[j].text.length)

  // Ignore whitespace tokens when judging how alike the lines are.
  const nonWs = (tokens: Token[]) =>
    tokens.reduce((c, t) => c + (isWhitespace(t.text) ? 0 : 1), 0)
  const denom = nonWs(a) + nonWs(b)
  const similarity = denom === 0 ? 1 : (2 * matchedNonWs) / denom
  if (similarity < MIN_SIMILARITY) return empty

  return { del, add }
}
