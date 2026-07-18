import { memo, useMemo } from "react"

import { MarkdownRenderer } from "@/components/ui/markdown-renderer"

/**
 * Splits streamed markdown into a stable prefix (every completed block) and the
 * still-growing tail (the current block). As tokens append to the tail the prefix
 * stays byte-identical, so the memoized prefix renderer never re-parses — parse
 * cost is bounded to the small last block instead of re-parsing the entire
 * message markdown on every streamed token.
 *
 * The boundary is the last top-level blank line; blank lines inside a code fence
 * are ignored so a streaming fence never splits mid-block.
 */
function splitPrefixTail(md: string): { prefix: string; tail: string } {
  const lines = md.split("\n")
  let inFence = false
  let boundary = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      inFence = !inFence
      continue
    }
    if (!inFence && lines[i].trim() === "") boundary = i
  }
  if (boundary < 0) return { prefix: "", tail: md }
  return {
    prefix: lines.slice(0, boundary).join("\n"),
    tail: lines.slice(boundary + 1).join("\n"),
  }
}

/** Memoized so the completed prefix only re-parses when a new block boundary
 *  advances it — not on every streamed token. */
const StablePrefix = memo(function StablePrefix({ content }: { content: string }) {
  return <MarkdownRenderer>{content}</MarkdownRenderer>
})

function StreamingBlocks({ text }: { text: string }) {
  const { prefix, tail } = useMemo(() => splitPrefixTail(text), [text])
  return (
    <>
      {prefix && <StablePrefix content={prefix} />}
      {tail && <MarkdownRenderer>{tail}</MarkdownRenderer>}
    </>
  )
}

export interface StreamingTextProps {
  text: string
  /** While streaming, render as stable-prefix + growing-tail; once settled render
   *  the whole message as one document so the final layout is exact. */
  streaming: boolean
}

/** Assistant answer text. Smooth streaming comes from the scroll easing
 *  (use-stick-to-bottom) plus bounded re-parse here — no per-character reveal. */
export function StreamingText({ text, streaming }: StreamingTextProps) {
  if (!streaming) return <MarkdownRenderer>{text}</MarkdownRenderer>
  return <StreamingBlocks text={text} />
}
