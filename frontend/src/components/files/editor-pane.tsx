import { useEffect, useRef } from "react"
import type { ReactNode } from "react"
import {
  ArrowCounterClockwise,
  ArrowsOut,
  CaretRight,
  Copy,
  DotsThree,
  FileImage,
  FileX,
  FloppyDisk,
  FolderOpen,
  GitDiff,
  SidebarSimple,
  Warning,
  X,
} from "@phosphor-icons/react"

import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { MarkdownRenderer } from "@/components/ui/markdown-renderer"
import type { EditorSettings } from "@/lib/editor-settings"
import { cn } from "@/lib/utils"

import { CodeEditor, DiffCodeEditor } from "./code-editor"
import {
  isImageFile,
  isMarkdownFile,
  isProseFile,
  type FileBuffers,
  type OpenFile,
  type ViewMode,
} from "./file-buffers"
import { fileKind } from "./file-icon"

/** Platform-aware save shortcut, resolved once for header hints. */
const SAVE_HINT =
  typeof navigator !== "undefined" && /Mac|iP/.test(navigator.platform)
    ? "⌘S"
    : "Ctrl+S"

interface EditorPaneProps {
  buffers: FileBuffers
  /** Direct URL for an image tab's bytes, when the source can serve them. */
  rawUrl?: (path: string) => string
  /** Sidebar toggle wired into the tab strip; omitted hides the button. */
  sidebarHidden?: boolean
  onToggleSidebar?: () => void
  /** Shown before any file is open. */
  empty?: ReactNode
}

/**
 * Tabs plus the active file's editor — the editing surface shared by the
 * workspace file viewer and the skill editor. Everything stateful lives in
 * {@link FileBuffers}, so this renders one set of behaviours no matter where the
 * files come from.
 */
export function EditorPane({
  buffers,
  rawUrl,
  sidebarHidden,
  onToggleSidebar,
  empty,
}: EditorPaneProps) {
  const {
    openFiles,
    activePath,
    setActivePath,
    closeFile,
    saveFile,
    discardChanges,
    copyPath,
    patch,
    settings,
    setSetting,
  } = buffers
  const active = openFiles.find((f) => f.path === activePath)

  if (openFiles.length === 0) return <>{empty ?? <EmptyEditor />}</>

  return (
    <>
      <TabStrip
        files={openFiles}
        activePath={activePath}
        sidebarHidden={sidebarHidden}
        onActivate={setActivePath}
        onClose={closeFile}
        onToggleSidebar={onToggleSidebar}
      />
      {active && (
        <EditorBody
          file={active}
          rawUrl={rawUrl}
          settings={settings}
          setSetting={setSetting}
          onSetView={(view) => patch(active.path, { view })}
          onChange={(value) =>
            patch(active.path, {
              content: value,
              dirty: value !== active.diskContent,
            })
          }
          onSave={() => void saveFile(active.path)}
          onDiscard={() => discardChanges(active.path)}
          onCopyPath={() => void copyPath(active.path)}
          onToggleDiff={() => patch(active.path, { diffView: !active.diffView })}
          onReloadConflict={() =>
            patch(active.path, {
              content: active.conflict ?? active.content,
              dirty: false,
              conflict: undefined,
            })
          }
          onDismissConflict={() => patch(active.path, { conflict: undefined })}
        />
      )}
    </>
  )
}

interface TabStripProps {
  files: OpenFile[]
  activePath?: string
  sidebarHidden?: boolean
  onActivate: (path: string) => void
  onClose: (path: string) => void
  onToggleSidebar?: () => void
}

function TabStrip({
  files,
  activePath,
  sidebarHidden,
  onActivate,
  onClose,
  onToggleSidebar,
}: TabStripProps) {
  // Keep the open tab in view when it changes — activating a file from the tree
  // (or closing a neighbour) can leave the active tab scrolled off-screen.
  const activeRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [activePath])

  return (
    <div className="flex h-9 min-w-0 shrink-0 items-stretch border-b border-border/40 bg-muted/30">
      <div className="no-scrollbar flex min-w-0 flex-1 items-stretch overflow-x-auto">
      {files.map((f) => {
        const isActive = f.path === activePath
        const { Icon: Glyph } = fileKind(f.name)
        return (
          <div
            key={f.path}
            ref={isActive ? activeRef : undefined}
            role="tab"
            aria-selected={isActive}
            tabIndex={0}
            onClick={() => onActivate(f.path)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onActivate(f.path)
            }}
            title={f.path}
            className={cn(
              "group relative flex items-center gap-1.5 px-3 text-xs whitespace-nowrap cursor-pointer outline-none transition-colors",
              // The active tab takes the editor's own surface (`card`) so it
              // reads as one continuous panel; others stay on the muted strip.
              // Layering, not borders, separates them — no lines between tabs.
              isActive
                ? "bg-card text-foreground"
                : "text-muted-foreground hover:bg-card/50 hover:text-foreground focus-visible:bg-card/50"
            )}
          >
            {/* Active rail — mirrors the tree's left rail across the top of the tab. */}
            {isActive && (
              <span className="absolute inset-x-0 top-0 h-0.5 bg-primary" />
            )}
            <Glyph
              className={cn(
                "h-3.5 w-3.5 shrink-0",
                isActive ? "text-foreground" : "text-muted-foreground/80"
              )}
            />
            <span>{f.name}</span>
            {/* Fixed trailing slot: a dirty dot that becomes the close target on
                hover/focus — so the tab width never jumps. */}
            <span className="relative ml-0.5 flex h-4 w-4 items-center justify-center">
              {f.dirty && (
                <span
                  className="h-1.5 w-1.5 rounded-full bg-foreground/70 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0"
                  aria-label="Unsaved changes"
                />
              )}
              <button
                type="button"
                aria-label={`Close ${f.name}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(f.path)
                }}
                className="absolute inset-0 flex items-center justify-center rounded opacity-0 outline-none hover:bg-background/60 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring group-hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          </div>
        )
      })}
      </div>
      {/* Pinned to the right of the scrolling tabs so it's always reachable —
          the only way back to the tree once it's hidden. */}
      {onToggleSidebar && (
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-pressed={sidebarHidden}
          title={sidebarHidden ? "Show file tree" : "Hide file tree"}
          aria-label={sidebarHidden ? "Show file tree" : "Hide file tree"}
          className={cn(
            "flex w-9 shrink-0 items-center justify-center border-l border-border/40 outline-none transition-colors hover:bg-card/50 hover:text-foreground focus-visible:bg-card/50",
            sidebarHidden ? "text-muted-foreground" : "text-foreground"
          )}
        >
          <SidebarSimple
            className="h-4 w-4 -scale-x-100"
            weight={sidebarHidden ? "regular" : "fill"}
          />
        </button>
      )}
    </div>
  )
}

interface EditorBodyProps {
  file: OpenFile
  rawUrl?: (path: string) => string
  settings: EditorSettings
  setSetting: <K extends keyof EditorSettings>(
    key: K,
    value: EditorSettings[K]
  ) => void
  onSetView: (view: ViewMode) => void
  onChange: (value: string) => void
  onSave: () => void
  onDiscard: () => void
  onCopyPath: () => void
  onToggleDiff: () => void
  onReloadConflict: () => void
  onDismissConflict: () => void
}

function EditorBody({
  file,
  rawUrl,
  settings,
  setSetting,
  onSetView,
  onChange,
  onSave,
  onDiscard,
  onCopyPath,
  onToggleDiff,
  onReloadConflict,
  onDismissConflict,
}: EditorBodyProps) {
  if (file.status === "loading") {
    return <Centered title={`Opening ${file.name}`}>Reading from disk…</Centered>
  }
  if (file.status === "error") {
    return (
      <Centered icon={Warning} title="Couldn’t open this file">
        {file.error ?? "The file couldn’t be read. Try opening it again."}
      </Centered>
    )
  }
  if (file.status === "deleted") {
    return (
      <Centered icon={FileX} title="Deleted on disk">
        {file.name} no longer exists. Close the tab, or save to write it back.
      </Centered>
    )
  }
  // Images render inline from the raw endpoint — checked before the binary/size
  // dead-ends, since `/read` reports images as binary and large ones as too big.
  if (isImageFile(file.name) && rawUrl) {
    return <ImagePreview src={rawUrl(file.path)} name={file.name} />
  }
  if (file.isBinary) {
    return (
      <Centered icon={FileImage} title="Binary file">
        This file isn’t text, so it can’t be shown in the editor.
      </Centered>
    )
  }
  if (file.truncated) {
    return (
      <Centered icon={ArrowsOut} title="File too large">
        This file is too big to open here. Use the terminal to work with it.
      </Centered>
    )
  }

  const { label: language } = fileKind(file.name)
  const lineCount = file.content.length ? file.content.split("\n").length : 0
  const markdown = isMarkdownFile(file.name)
  // Prose wraps by default; the global toggle can only add wrapping, not remove
  // it for a doc. Everything else follows the Word Wrap setting verbatim.
  const display = {
    ...settings,
    wordWrap: settings.wordWrap || isProseFile(file.name),
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {file.conflict !== undefined && (
        <div className="flex items-center gap-2 border-b border-border/40 bg-accent/40 px-3 py-1.5 text-xs text-foreground">
          <Warning className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="flex-1">
            This file changed on disk while you had unsaved edits.
          </span>
          <button
            type="button"
            onClick={onReloadConflict}
            className="rounded px-1.5 py-0.5 font-medium hover:bg-background/60"
          >
            Use disk version
          </button>
          <button
            type="button"
            onClick={onDismissConflict}
            className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-background/60 hover:text-foreground"
          >
            Keep my edits
          </button>
        </div>
      )}
      <div className="flex h-8 min-w-0 shrink-0 items-center justify-between gap-3 border-b border-border/40 pl-3 pr-2">
        <Breadcrumb path={file.path} />
        <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
          {file.diffView && (
            <span className="hidden items-center gap-1 font-mono uppercase tracking-wide text-primary sm:inline-flex">
              <GitDiff className="h-3 w-3" />
              Diff
            </span>
          )}
          <span className="hidden font-mono uppercase tracking-wide sm:inline">
            {language}
          </span>
          {lineCount > 0 && (
            <span className="hidden font-mono tabular-nums sm:inline">
              {lineCount} {lineCount === 1 ? "line" : "lines"}
            </span>
          )}
          <button
            type="button"
            onClick={onSave}
            disabled={!file.dirty || file.saving}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors",
              "hover:bg-accent hover:text-foreground",
              "disabled:pointer-events-none disabled:opacity-40",
              file.dirty && !file.saving && "text-foreground"
            )}
            title={`Save (${SAVE_HINT})`}
          >
            <FloppyDisk className="h-3.5 w-3.5" />
            {file.saving ? "Saving…" : "Save"}
            {file.dirty && !file.saving && (
              <kbd className="hidden rounded border border-border/60 bg-muted px-1 font-mono text-[10px] leading-tight text-muted-foreground md:inline">
                {SAVE_HINT}
              </kbd>
            )}
          </button>
          <EditorMenu
            file={file}
            markdown={markdown}
            settings={settings}
            setSetting={setSetting}
            onSetView={onSetView}
            onSave={onSave}
            onDiscard={onDiscard}
            onCopyPath={onCopyPath}
            onToggleDiff={onToggleDiff}
          />
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {file.diffView ? (
          <DiffCodeEditor
            path={file.path}
            original={file.diskContent}
            modified={file.content}
            display={display}
            onChange={onChange}
          />
        ) : markdown && file.view === "preview" ? (
          <MarkdownPreview content={file.content} />
        ) : markdown && file.view === "split" ? (
          <ResizablePanelGroup
            direction="horizontal"
            autoSaveId="md-split"
            className="h-full"
          >
            <ResizablePanel minSize={25} className="min-w-0">
              <CodeEditor
                path={file.path}
                value={file.content}
                display={display}
                onChange={onChange}
                onSave={onSave}
              />
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel minSize={25} className="min-w-0">
              <MarkdownPreview content={file.content} />
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          <CodeEditor
            path={file.path}
            value={file.content}
            display={display}
            onChange={onChange}
            onSave={onSave}
          />
        )}
      </div>
    </div>
  )
}

/** Rendered Markdown in a scrollable, comfortably-padded reading column. */
function MarkdownPreview({ content }: { content: string }) {
  return (
    <div className="h-full overflow-auto bg-card px-6 py-5">
      <div className="mx-auto max-w-3xl">
        {content.trim() ? (
          <MarkdownRenderer>{content}</MarkdownRenderer>
        ) : (
          <p className="text-sm text-muted-foreground">This file is empty.</p>
        )}
      </div>
    </div>
  )
}

/** Inline image preview, centered on the editor surface with a size hint. */
function ImagePreview({ src, name }: { src: string; name: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 overflow-auto bg-card p-6">
      <img
        src={src}
        alt={name}
        className="max-h-full max-w-full rounded-md object-contain shadow-sm"
      />
      <p className="font-mono text-[11px] text-muted-foreground">{name}</p>
    </div>
  )
}

interface EditorMenuProps {
  file: OpenFile
  markdown: boolean
  settings: EditorSettings
  setSetting: <K extends keyof EditorSettings>(
    key: K,
    value: EditorSettings[K]
  ) => void
  onSetView: (view: ViewMode) => void
  onSave: () => void
  onDiscard: () => void
  onCopyPath: () => void
  onToggleDiff: () => void
}

/**
 * The header's overflow menu ("…"): file actions on top (save/discard/copy),
 * a render-mode picker for markdown, then display toggles. Toggle items keep
 * the menu open (`preventDefault`) so several can be flipped in one pass;
 * action items close as usual.
 */
function EditorMenu({
  file,
  markdown,
  settings,
  setSetting,
  onSetView,
  onSave,
  onDiscard,
  onCopyPath,
  onToggleDiff,
}: EditorMenuProps) {
  const canWrite = file.dirty && !file.saving
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-accent data-[state=open]:text-foreground"
        aria-label="Editor options"
        title="Editor options"
      >
        <DotsThree className="h-4 w-4" weight="bold" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={onSave} disabled={!canWrite}>
          <FloppyDisk className="h-4 w-4" />
          Save File
          <DropdownMenuShortcut>{SAVE_HINT}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onDiscard} disabled={!canWrite}>
          <ArrowCounterClockwise className="h-4 w-4" />
          Discard Changes
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onCopyPath}>
          <Copy className="h-4 w-4" />
          Copy Relative Path
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {markdown && (
          <>
            <DropdownMenuLabel>View</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={file.view}
              onValueChange={(v) => onSetView(v as ViewMode)}
            >
              <DropdownMenuRadioItem value="preview">
                Preview
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="code">Editor</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="split">Split</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuCheckboxItem
          checked={file.diffView}
          onSelect={(e) => e.preventDefault()}
          onCheckedChange={onToggleDiff}
        >
          Diff View
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={settings.lineNumbers}
          onSelect={(e) => e.preventDefault()}
          onCheckedChange={(v) => setSetting("lineNumbers", v)}
        >
          Line Numbers
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={settings.wordWrap}
          onSelect={(e) => e.preventDefault()}
          onCheckedChange={(v) => setSetting("wordWrap", v)}
        >
          Word Wrap
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={settings.minimap}
          onSelect={(e) => e.preventDefault()}
          onCheckedChange={(v) => setSetting("minimap", v)}
        >
          Minimap
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={settings.autoSave}
          onSelect={(e) => e.preventDefault()}
          onCheckedChange={(v) => setSetting("autoSave", v)}
        >
          Auto Save
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The active file's *location* — its folder path, muted and chevron-separated.
 * The filename is deliberately omitted: the tab already carries it, so echoing
 * it here (as the old breadcrumb did) only duplicated text for root-level files.
 * Renders as an empty flex slot at the root so the header's right cluster stays
 * pinned right.
 */
function Breadcrumb({ path }: { path: string }) {
  const folders = path.split("/").slice(0, -1)
  return (
    <nav
      aria-label="File location"
      className="flex min-w-0 items-center gap-1 overflow-hidden font-mono text-xs text-muted-foreground"
    >
      {folders.map((seg, i) => (
        <span key={i} className="flex min-w-0 shrink items-center gap-1">
          {i > 0 && (
            <CaretRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
          )}
          <span className="truncate">{seg}</span>
        </span>
      ))}
    </nav>
  )
}

/** Resting state before any file is open — an invitation, not a dead end. */
function EmptyEditor() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <FolderOpen className="h-7 w-7 text-muted-foreground/60" />
      <p className="text-sm font-medium text-foreground">No file open</p>
      <p className="max-w-xs text-xs text-muted-foreground">
        Pick a file from the explorer to read or edit it. Changes an agent makes
        show up here live.
      </p>
    </div>
  )
}

export function Centered({
  icon: Icon,
  title,
  children,
}: {
  icon?: React.ElementType
  title?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1.5 p-6 text-center">
      {Icon && <Icon className="mb-1 h-6 w-6 text-muted-foreground/60" />}
      {title && <p className="text-sm font-medium text-foreground">{title}</p>}
      <p className="max-w-xs text-xs text-muted-foreground">{children}</p>
    </div>
  )
}
