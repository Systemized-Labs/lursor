import { Children, isValidElement, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import {
  ArrowSquareOut,
  Check,
  Copy,
  Globe,
  LinkSimple,
} from '@phosphor-icons/react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { API_BASE } from '@/api/client'
import { filesApi } from '@/api/files'
import { useWorkspace } from '@/api/workspaces'
import { cn, copyToClipboard } from '@/lib/utils'
import { processChildrenWithIcons } from '@/lib/emoji-icons'
import { openExternal } from '@/lib/open-external'
import { requestOpenPreview } from '@/lib/open-preview'

interface MarkdownRendererProps {
  children: string
  className?: string
  /** Directory that relative links/images in this markdown resolve against,
   *  as a workspace-relative POSIX path ("" is the workspace root). Chat text
   *  quotes paths from the workspace root, so the default is right there; a
   *  previewed `.md` file passes its own folder. */
  basePath?: string
}

/** Recursively flatten a React node tree back to plain text (for copy). */
function nodeToText(node: ReactNode): string {
  if (node == null || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeToText).join('')
  if (isValidElement(node)) return nodeToText((node.props as { children?: ReactNode }).children)
  return ''
}

/**
 * Fenced code block with a header bar: language label + copy button.
 * `pre` from react-markdown wraps a single highlighted `<code>` element —
 * we keep that child verbatim (preserving highlight.js spans) and add chrome.
 */
function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const codeEl = Children.toArray(children).find((c) => isValidElement(c)) as
    | React.ReactElement<{ className?: string; children?: ReactNode }>
    | undefined

  if (!codeEl) {
    return <pre className="max-h-96 overflow-auto p-3 text-xs">{children}</pre>
  }

  const className = codeEl.props.className ?? ''
  const lang = /language-(\w+)/.exec(className)?.[1] ?? ''
  const raw = nodeToText(codeEl.props.children)

  const copy = () => {
    copyToClipboard(raw).then((ok) => {
      if (!ok) return
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="group/code relative my-2 overflow-hidden rounded-md border border-border bg-muted/50">
      <div className="flex items-center justify-between border-b border-border/60 bg-muted/40 px-3 py-1">
        <span className="text-[10px] font-mono uppercase tracking-wide text-muted-foreground">
          {lang || 'code'}
        </span>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-background/60 hover:text-foreground"
          aria-label="Copy code"
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="max-h-96 overflow-auto p-3 text-xs leading-relaxed">
        <code className={className}>{codeEl.props.children}</code>
      </pre>
    </div>
  )
}

/**
 * A markdown anchor with a right-click menu — the Cursor-style link actions:
 * open in the in-app "Lursor Browser" (the preview dock), open in the system
 * browser, or copy the link. Left-click still follows the link as usual.
 *
 * The "Lursor Browser" action targets the active workspace's preview panel, so
 * it's only offered inside a workspace route and only for http(s) URLs.
 */
function MarkdownLink({
  href,
  children,
  ...props
}: {
  href?: string
  children?: ReactNode
}) {
  const { pathname } = useLocation()
  const url = href ?? ''
  const isWebLink = /^https?:\/\//i.test(url)
  const workspaceId = pathname.match(/\/workspaces\/([^/]+)/)?.[1]

  const anchor = (
    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
      {processChildrenWithIcons(children, 'a')}
    </a>
  )

  // Only web links get the menu; anchors, mailto:, etc. keep default behavior.
  if (!isWebLink) return anchor

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{anchor}</ContextMenuTrigger>
      <ContextMenuContent>
        {workspaceId && (
          <ContextMenuItem
            onSelect={() => requestOpenPreview({ workspaceId, url })}
          >
            <Globe />
            Open in Lursor Browser
          </ContextMenuItem>
        )}
        <ContextMenuItem onSelect={() => openExternal(url)}>
          <ArrowSquareOut />
          Open in External Browser
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void copyToClipboard(url)}>
          <LinkSimple />
          Copy Link
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** Collapse `.`/`..` segments in a POSIX-style path. */
function normalizePath(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

/**
 * Turn a markdown image `src` into something the browser can actually fetch.
 *
 * An agent that generates an image reports where it landed as a workspace-
 * relative path (`.agents/image/gen/squirrel-<run>.png`), and models write that
 * straight into an `![...]()`. The browser resolves it against the *page* URL —
 * `/workspaces/<id>/threads/<id>/.agents/...` — which is a route, not a file, so
 * the image breaks. Point it at the workspace file server instead.
 *
 * Returns null when the reference can't be served: no workspace in scope, or an
 * absolute path outside the workspace root (the `/files/raw` endpoint confines
 * every read to that root, so linking there would only 404 later).
 */
function resolveImageSrc(
  src: string,
  workspaceId: string | undefined,
  workspaceRoot: string | undefined,
  basePath: string,
): string | null {
  const raw = src.trim()
  if (!raw) return null
  // Already fetchable as-is.
  if (/^(https?:|data:|blob:)/i.test(raw)) return raw
  if (!workspaceId) return null

  let path = raw
  if (/^file:\/\//i.test(path)) {
    try {
      path = decodeURIComponent(new URL(path).pathname)
    } catch {
      return null
    }
  }

  // A backend route quoted root-relative (`/api/images/<run>/content`) resolves
  // against the *page* origin, which in dev and on the LAN is not the API's.
  if (path.startsWith('/api/')) return `${API_BASE}${path.slice(4)}`

  if (path.startsWith('/')) {
    // Absolute on the backend's disk — only serveable if it's inside the
    // workspace, in which case the endpoint wants the part below the root.
    if (!workspaceRoot) return null
    const root = workspaceRoot.replace(/\/+$/, '')
    if (path !== root && !path.startsWith(`${root}/`)) return null
    path = path.slice(root.length + 1)
  } else {
    path = basePath ? `${basePath}/${path}` : path
  }

  const relative = normalizePath(path)
  if (!relative) return null
  return filesApi.rawUrl(workspaceId, relative)
}

/**
 * A markdown image, resolved against the workspace and rendered as a bounded,
 * bordered block. A src we can't resolve — or bytes that fail to load — falls
 * back to a labelled placeholder instead of the browser's broken-image icon, so
 * a wrong path reads as a wrong path.
 */
function MarkdownImage({
  src,
  alt,
  title,
  basePath,
}: {
  src?: string
  alt?: string
  title?: string
  basePath: string
}) {
  const { pathname } = useLocation()
  const workspaceId = pathname.match(/\/workspaces\/([^/]+)/)?.[1]
  const { data: workspace } = useWorkspace(workspaceId)
  // The URL that failed, not a boolean: mid-stream the src arrives a character
  // at a time, so the first few loads 404 on a truncated path. Keyed this way,
  // the finished URL gets its own attempt instead of inheriting the failure.
  const [failedSrc, setFailedSrc] = useState<string | null>(null)

  const raw = src ?? ''
  const resolved = resolveImageSrc(raw, workspaceId, workspace?.path, basePath)

  if (!resolved || failedSrc === resolved) {
    return (
      <span className="my-2 inline-flex max-w-full flex-col gap-0.5 rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 align-middle">
        <span className="text-xs text-muted-foreground">
          {alt?.trim() || 'Image unavailable'}
        </span>
        {raw && (
          <span className="truncate font-mono text-[11px] text-muted-foreground/70">
            {raw}
          </span>
        )}
      </span>
    )
  }

  return (
    <img
      src={resolved}
      alt={alt ?? ''}
      title={title}
      loading="lazy"
      onError={() => setFailedSrc(resolved)}
      // inline-block, not block: a row of badges in a README should stay a row.
      className="my-3 inline-block max-h-[28rem] w-auto max-w-full rounded-lg border border-border object-contain align-middle"
    />
  )
}

export function MarkdownRenderer({
  children,
  className,
  basePath = '',
}: MarkdownRendererProps) {
  return (
    <div
      className={cn(
        'prose prose-invert min-w-0 max-w-full break-words',
        // Comfortable reading size — ~15px (0.9375rem) on a generous line-height,
        // the single biggest lever for the calm, document-like feel. Expressed in
        // rem so it scales with the root font-size (the app-wide UI scale) instead
        // of staying pinned at a fixed px. Collapse the leading element's top
        // margin so a turn doesn't open with a big gap.
        'text-[0.9375rem] leading-7 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        // Body — slightly muted for a calm read; headings/strong stay full
        // strength to carry the hierarchy.
        '[&_p]:text-foreground/85 [&_p]:my-3 [&_p]:leading-7',
        '[&_li]:text-foreground/85 [&_li]:leading-7',
        '[&_strong]:text-foreground [&_strong]:font-semibold',
        '[&_em]:text-foreground/85',
        '[&_blockquote]:text-muted-foreground [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:my-3',
        // Headings — a clear step above body, with air above each.
        '[&_h1]:text-foreground [&_h2]:text-foreground [&_h3]:text-foreground [&_h4]:text-foreground',
        '[&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_h4]:font-semibold',
        '[&_h1]:text-xl [&_h2]:text-lg [&_h3]:text-base [&_h4]:text-[0.9375rem]',
        '[&_h1]:mt-6 [&_h1]:mb-3 [&_h2]:mt-6 [&_h2]:mb-2 [&_h3]:mt-5 [&_h3]:mb-2 [&_h4]:mt-4 [&_h4]:mb-1.5',
        // Inline code — soft chip, slightly smaller than the surrounding text.
        '[&_:not(pre)>code]:text-foreground/90 [&_:not(pre)>code]:bg-muted/70 [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:rounded-md [&_:not(pre)>code]:text-[0.85em] [&_:not(pre)>code]:font-mono',
        '[&_:not(pre)>code]:before:content-none [&_:not(pre)>code]:after:content-none',
        // Code blocks (chrome owned by CodeBlock; just style the inner code)
        '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-foreground [&_pre_code]:text-[0.8125rem]',
        // Tables
        '[&_table]:w-full [&_table]:border-collapse [&_table]:text-sm [&_table]:my-3',
        '[&_th]:text-foreground [&_th]:font-semibold [&_th]:text-left [&_th]:px-3 [&_th]:py-2 [&_th]:border [&_th]:border-border [&_th]:bg-muted/60',
        '[&_td]:text-foreground/85 [&_td]:px-3 [&_td]:py-2 [&_td]:border [&_td]:border-border',
        '[&_tr:nth-child(even)_td]:bg-muted/20',
        // Links
        '[&_a]:text-primary [&_a]:no-underline hover:[&_a]:underline [&_a]:underline-offset-2',
        // Lists — clear separation between items, muted markers.
        '[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:space-y-1.5',
        '[&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:space-y-1.5',
        '[&_li]:my-0 [&_li]:pl-1.5 [&_li]:marker:text-muted-foreground/70',
        // HR
        '[&_hr]:border-border [&_hr]:my-5',
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          table: ({ children, ...props }) => (
            <div className="overflow-x-auto my-2">
              <table {...props}>{children}</table>
            </div>
          ),
          a: ({ href, children, ...props }) => (
            <MarkdownLink href={href} {...props}>
              {children}
            </MarkdownLink>
          ),
          img: ({ src, alt, title }) => (
            <MarkdownImage
              src={typeof src === 'string' ? src : undefined}
              alt={alt}
              title={title}
              basePath={basePath}
            />
          ),
          p: ({ children }) => (
            <p>{processChildrenWithIcons(children, 'p')}</p>
          ),
          li: ({ children, ...props }) => (
            <li {...props}>{processChildrenWithIcons(children, 'li')}</li>
          ),
          strong: ({ children }) => (
            <strong>{processChildrenWithIcons(children, 'strong')}</strong>
          ),
          em: ({ children }) => (
            <em>{processChildrenWithIcons(children, 'em')}</em>
          ),
          h1: ({ children }) => (
            <h1>{processChildrenWithIcons(children, 'h1')}</h1>
          ),
          h2: ({ children }) => (
            <h2>{processChildrenWithIcons(children, 'h2')}</h2>
          ),
          h3: ({ children }) => (
            <h3>{processChildrenWithIcons(children, 'h3')}</h3>
          ),
          h4: ({ children }) => (
            <h4>{processChildrenWithIcons(children, 'h4')}</h4>
          ),
          td: ({ children, ...props }) => (
            <td {...props}>{processChildrenWithIcons(children, 'td')}</td>
          ),
          th: ({ children, ...props }) => (
            <th {...props}>{processChildrenWithIcons(children, 'th')}</th>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
