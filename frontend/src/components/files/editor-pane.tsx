import { useCallback, useEffect, useRef, useState } from "react"
import type { KeyboardEvent, ReactNode } from "react"
import type * as Monaco from "monaco-editor"
import {
  ArrowCounterClockwise,
  ArrowLineLeft,
  ArrowsOut,
  ArrowsLeftRight,
  CaretRight,
  Copy,
  DotsThree,
  FileAudio,
  FileImage,
  FileVideo,
  FileX,
  FloppyDisk,
  FolderOpen,
  GitDiff,
  MagnifyingGlass,
  SidebarSimple,
  SquareSplitHorizontal,
  TextAa,
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
  filesInGroup,
  isImageFile,
  isMarkdownFile,
  isMediaFile,
  isProseFile,
  isVideoFile,
  type EditorGroup,
  type FileBuffers,
  type OpenFile,
  type ViewMode,
} from "./file-buffers"
import { fileKind } from "./file-icon"

/**
 * Drag payload for moving a file tab between editor groups. A custom MIME type
 * rather than `text/plain`, so the strip only accepts drags that are actually
 * ours — and so `dragover` can tell without reading the data, which the browser
 * won't allow mid-drag.
 */
const TAB_DRAG_TYPE = "application/x-lursor-file-tab"

const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iP/.test(navigator.platform)

/** Platform-aware shortcut hints for the header and the `…` menu. */
const SAVE_HINT = IS_MAC ? "⌘S" : "Ctrl+S"
const FIND_HINT = IS_MAC ? "⌘F" : "Ctrl+F"
// Monaco's own default for replace, which differs by platform — ⌘H is the system
// "hide window" on macOS, so the editor never claims it there.
const REPLACE_HINT = IS_MAC ? "⌘⌥F" : "Ctrl+H"

/** Monaco action ids the pane drives directly. */
const FIND_ACTION = "actions.find"
const REPLACE_ACTION = "editor.action.startFindReplaceAction"

interface EditorPaneProps {
  buffers: FileBuffers
  /** Direct URL for an image tab's bytes, when the source can serve them. */
  rawUrl?: (path: string) => string
  /** Sidebar toggle wired into the tab strip; omitted hides the button. */
  sidebarHidden?: boolean
  onToggleSidebar?: () => void
  /** Shown before any file is open. */
  empty?: ReactNode
  /** Which editor group this pane renders. Defaults to the only one there is. */
  group?: EditorGroup
  /**
   * Whether the host actually lays out two groups. Off for the skill editor,
   * which renders one pane — offering "Split Right" there would tag a buffer into
   * a group nothing renders, and the file would appear to vanish.
   */
  splitEnabled?: boolean
  /** True when the panel is too narrow for two editors; the control says so. */
  splitTooNarrow?: boolean
  /** Fold this group away. Offered on the secondary group only. */
  onCloseGroup?: () => void
}

/**
 * Tabs plus the active file's editor — the editing surface shared by the
 * workspace file viewer and the skill editor. Everything stateful lives in
 * {@link FileBuffers}, so this renders one set of behaviours no matter where the
 * files come from.
 *
 * With a split, the host renders one of these per group and each shows only the
 * tabs tagged with its own — but they read from one buffer store, so a file open
 * in both groups is one buffer, saved once and reconciled once. Clicking anywhere
 * in a pane makes its group the focused one, which is where a file opened from the
 * tree or from a search result lands.
 */
export function EditorPane({
  buffers,
  rawUrl,
  sidebarHidden,
  onToggleSidebar,
  empty,
  group = 0,
  splitEnabled = false,
  splitTooNarrow = false,
  onCloseGroup,
}: EditorPaneProps) {
  const {
    openFiles,
    activePaths,
    focusedGroup,
    setActivePath,
    setFocusedGroup,
    closeFile,
    splitFile,
    moveToGroup,
    saveFile,
    discardChanges,
    copyPath,
    patch,
    clearReveal,
    settings,
    setSetting,
  } = buffers
  const files = filesInGroup(openFiles, group)
  const active = files.find((f) => f.path === activePaths[group])
  const focused = focusedGroup === group
  const { editorRef, runEditorAction, onPaneKeyDown } = useEditorActions()

  // Any interaction inside this pane claims focus for its group, so the next file
  // opened from the tree or a search result lands where the user is looking.
  const claimFocus = () => {
    if (!focused) setFocusedGroup(group)
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={onPaneKeyDown}
      // Capture, so a click landing inside Monaco's own DOM still registers.
      onMouseDownCapture={claimFocus}
      onFocusCapture={claimFocus}
      // A container listening for keys, not an interactive element itself — the
      // real targets inside it (tabs, buttons, the editor) carry their own roles.
      role="presentation"
    >
      {files.length === 0 ? (
        empty ?? <EmptyEditor />
      ) : (
        <>
          <TabStrip
            files={files}
            activePath={activePaths[group]}
            focused={focused || !splitEnabled}
            acceptsDrops={splitEnabled}
            sidebarHidden={sidebarHidden}
            onActivate={(path) => setActivePath(path, group)}
            onClose={(path) => closeFile(path, group)}
            onMoveHere={(path) => moveToGroup(path, group)}
            onToggleSidebar={onToggleSidebar}
            onCloseGroup={onCloseGroup}
          />
          {active && (
            <EditorBody
              file={active}
              rawUrl={rawUrl}
              settings={settings}
              setSetting={setSetting}
              editorRef={editorRef}
              splitEnabled={splitEnabled}
              splitTooNarrow={splitTooNarrow}
              group={group}
              onFind={() => runEditorAction(FIND_ACTION)}
              onReplace={() => runEditorAction(REPLACE_ACTION)}
              onSplit={() => splitFile(active.path)}
              onMoveToOtherGroup={() =>
                moveToGroup(active.path, group === 0 ? 1 : 0)
              }
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
              onToggleDiff={() =>
                patch(active.path, { diffView: !active.diffView })
              }
              onRevealed={() => clearReveal(active.path)}
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
      )}
    </div>
  )
}

/**
 * A handle on the live Monaco editor, plus the two ways the pane reaches it.
 *
 * Monaco's find widget has always worked, but only from inside the text area and
 * with nothing anywhere advertising it. This makes it reachable from the header
 * button and the `…` menu, and binds the shortcuts at the *pane* level so they
 * also fire when focus is in the file tab strip or the header rather than in the
 * text — the case where a person has just clicked a tab and typed ⌘F.
 */
function useEditorActions() {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)

  const runEditorAction = useCallback((id: string) => {
    if (!editorRef.current) return
    // Deferred a frame: when this comes from the `…` menu, Radix restores focus
    // to the trigger as the menu closes, which would pull focus straight back
    // out of the find input we are about to open.
    requestAnimationFrame(() => {
      const editor = editorRef.current
      if (!editor) return
      editor.focus()
      void editor.getAction(id)?.run()
    })
  }, [])

  const onPaneKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      // Inside the text area Monaco owns these already, and its own handling is
      // the better one (it seeds find from the selection).
      if ((event.target as HTMLElement | null)?.closest(".monaco-editor")) return
      if (IS_MAC ? !event.metaKey : !event.ctrlKey) return
      // Keyed on `code`, not `key`: with Option held, macOS reports ⌥F as "ƒ".
      if (event.code === "KeyF" && !event.altKey) {
        event.preventDefault()
        runEditorAction(FIND_ACTION)
      } else if (IS_MAC ? event.code === "KeyF" && event.altKey : event.code === "KeyH") {
        event.preventDefault()
        runEditorAction(REPLACE_ACTION)
      }
    },
    [runEditorAction]
  )

  return { editorRef, runEditorAction, onPaneKeyDown }
}

interface TabStripProps {
  files: OpenFile[]
  activePath?: string
  /** Whether this strip's group has focus; the active rail fades when it doesn't. */
  focused: boolean
  /** Whether a tab dragged from the other group can be dropped here. */
  acceptsDrops: boolean
  sidebarHidden?: boolean
  onActivate: (path: string) => void
  onClose: (path: string) => void
  onMoveHere: (path: string) => void
  onToggleSidebar?: () => void
  onCloseGroup?: () => void
}

function TabStrip({
  files,
  activePath,
  focused,
  acceptsDrops,
  sidebarHidden,
  onActivate,
  onClose,
  onMoveHere,
  onToggleSidebar,
  onCloseGroup,
}: TabStripProps) {
  // Keep the open tab in view when it changes — activating a file from the tree
  // (or closing a neighbour) can leave the active tab scrolled off-screen.
  const activeRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [activePath])

  // Highlighted while a tab from the other group hovers over this strip. Plain
  // HTML5 drag and drop — a whole dnd library for one payload of one string would
  // be a poor trade.
  const [dropActive, setDropActive] = useState(false)

  return (
    <div
      className={cn(
        // No bottom border here: the strip's lower edge is drawn by its children
        // so the active tab can *interrupt* it (see the tab's own `border-b`).
        //
        // 32px against the dock strip's 36px. The dock strip says which *panel*
        // this is; this one says which *file* is open inside it, and a nested
        // thing that reads as smaller is a hierarchy the eye resolves before it
        // has read either label. `SideViewSwitch` in `file-viewer.tsx` matches,
        // so the two columns' header rows still line up.
        "flex h-8 min-w-0 shrink-0 items-stretch bg-muted/30 transition-colors",
        dropActive && "bg-accent/60"
      )}
      onDragOver={
        acceptsDrops
          ? (e) => {
              // `getData` is unreadable during a drag, so the type list is the
              // only way to know whether this drop is ours to take.
              if (!e.dataTransfer.types.includes(TAB_DRAG_TYPE)) return
              e.preventDefault()
              e.dataTransfer.dropEffect = "move"
              setDropActive(true)
            }
          : undefined
      }
      onDragLeave={acceptsDrops ? () => setDropActive(false) : undefined}
      onDrop={
        acceptsDrops
          ? (e) => {
              setDropActive(false)
              const path = e.dataTransfer.getData(TAB_DRAG_TYPE)
              if (!path) return
              e.preventDefault()
              onMoveHere(path)
            }
          : undefined
      }
    >
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
            draggable={acceptsDrops}
            onDragStart={(e) => {
              e.dataTransfer.setData(TAB_DRAG_TYPE, f.path)
              e.dataTransfer.effectAllowed = "move"
            }}
            onClick={() => onActivate(f.path)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onActivate(f.path)
            }}
            title={f.path}
            className={cn(
              // `font-mono` is the split against the dock's pane tabs, which are
              // uppercase and letterspaced in `--font-sans` ("Geist Pixel"). A
              // pane tab is a *label* — FILES, CHAT — and a file tab is a
              // *filename*, so setting them in genuinely different faces is the
              // typography agreeing with what they are. Both are single-width
              // faces at a glance, so this only reads once the strips are side by
              // side, which is exactly when it needs to.
              "group relative flex shrink-0 items-center gap-1.5 border-b px-2.5 font-mono text-[11px] whitespace-nowrap cursor-pointer outline-none transition-colors",
              // The active tab takes the editor's own surface (`card`) and
              // *notches through* the strip's bottom edge — a transparent border
              // lets its own fill run into the editor below, so the two read as
              // one continuous panel. Shape alone carries "active" here; the
              // `primary` accent is reserved for the dock's pane tabs, one level
              // up, so a Files pane shows exactly one accent bar rather than two
              // stacked rails a few pixels apart.
              isActive
                ? "border-transparent bg-card"
                : "border-border/40 text-muted-foreground hover:bg-card/50 hover:text-foreground focus-visible:bg-card/50",
              // With a split, the group that doesn't have focus still shows which
              // file it holds — it just says so quietly, since the next file
              // opened from the tree lands in the other one.
              isActive && (focused ? "text-foreground" : "text-muted-foreground")
            )}
          >
            <Glyph
              className={cn(
                "h-3 w-3 shrink-0",
                isActive && focused ? "text-foreground" : "text-muted-foreground/80"
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
      {/* Carries the strip's bottom edge across whatever the tabs don't fill.
          Grows but never shrinks, so once the tabs overflow and scroll it
          collapses to nothing instead of stealing width from them. */}
      <div aria-hidden className="grow shrink-0 basis-0 border-b border-border/40" />
      </div>
      {/* Fold the split away. Only on the secondary group: group 0 is the pane
          itself, and its tabs come back here when this one closes. */}
      {onCloseGroup && (
        <button
          type="button"
          onClick={onCloseGroup}
          title="Close this group (its tabs move to the other one)"
          aria-label="Close editor group"
          className="flex w-8 shrink-0 items-center justify-center border-b border-l border-border/40 text-muted-foreground outline-none transition-colors hover:bg-card/50 hover:text-foreground focus-visible:bg-card/50"
        >
          <ArrowLineLeft className="h-3.5 w-3.5" />
        </button>
      )}
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
            "flex w-8 shrink-0 items-center justify-center border-b border-l border-border/40 outline-none transition-colors hover:bg-card/50 hover:text-foreground focus-visible:bg-card/50",
            sidebarHidden ? "text-muted-foreground" : "text-foreground"
          )}
        >
          <SidebarSimple
            className="h-3.5 w-3.5 -scale-x-100"
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
  /** Filled by the code editor on mount, cleared on unmount. */
  editorRef: React.MutableRefObject<Monaco.editor.IStandaloneCodeEditor | null>
  splitEnabled: boolean
  splitTooNarrow: boolean
  group: EditorGroup
  onFind: () => void
  onReplace: () => void
  onSplit: () => void
  onMoveToOtherGroup: () => void
  /** The pending reveal landed; forget it so it can't fire twice. */
  onRevealed: () => void
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
  editorRef,
  splitEnabled,
  splitTooNarrow,
  group,
  onFind,
  onReplace,
  onSplit,
  onMoveToOtherGroup,
  onRevealed,
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
  // Media renders inline from the raw endpoint — checked before the binary/size
  // dead-ends, since `/read` reports these as binary and anything past a couple
  // of megabytes (which is most video) as too big to open.
  if (rawUrl && isMediaFile(file.name)) {
    return (
      <MediaPreview
        src={rawUrl(file.path)}
        name={file.name}
        revision={file.revision}
      />
    )
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
          {/* The find widget has always been in there; this is the first thing
              that says so. Hidden in Diff View, where the action would open a
              find bar over an editor the user is reading, not searching. */}
          {!file.diffView && (
            <button
              type="button"
              onClick={onFind}
              className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title={`Find in file (${FIND_HINT})`}
              aria-label="Find in file"
            >
              <MagnifyingGlass className="h-3.5 w-3.5" />
            </button>
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
            splitEnabled={splitEnabled}
            splitTooNarrow={splitTooNarrow}
            group={group}
            onFind={onFind}
            onReplace={onReplace}
            onSplit={onSplit}
            onMoveToOtherGroup={onMoveToOtherGroup}
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
          <MarkdownPreview content={file.content} path={file.path} />
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
                onReady={(editor) => (editorRef.current = editor)}
                reveal={file.reveal}
                onRevealed={onRevealed}
              />
            </ResizablePanel>
            <ResizableHandle />
            <ResizablePanel minSize={25} className="min-w-0">
              <MarkdownPreview content={file.content} path={file.path} />
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          <CodeEditor
            path={file.path}
            value={file.content}
            display={display}
            onChange={onChange}
            onSave={onSave}
            onReady={(editor) => (editorRef.current = editor)}
            reveal={file.reveal}
            onRevealed={onRevealed}
          />
        )}
      </div>
    </div>
  )
}

/** Rendered Markdown in a scrollable, comfortably-padded reading column.
 *
 *  `path` is the file's own workspace-relative path — its folder is what the
 *  document's relative image references resolve against, the same as any other
 *  markdown viewer. */
function MarkdownPreview({ content, path }: { content: string; path: string }) {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""
  return (
    <div className="h-full overflow-auto bg-card px-6 py-5">
      <div className="mx-auto max-w-3xl">
        {content.trim() ? (
          <MarkdownRenderer basePath={dir}>{content}</MarkdownRenderer>
        ) : (
          <p className="text-sm text-muted-foreground">This file is empty.</p>
        )}
      </div>
    </div>
  )
}

/**
 * Inline preview for a media file: an image, a video player, or an audio player,
 * centered on the editor surface with the filename beneath it.
 *
 * All three share this one frame because they are the same thing from the
 * editor's point of view — bytes the raw endpoint serves and Monaco can't hold.
 * What differs is only the element, and what happens when it won't play: a
 * container we listed but whose codec this browser lacks (an H.265 `.mov`, say)
 * fires `error` rather than rendering, so the frame swaps in a notice with the
 * path to work with instead of leaving a black rectangle on screen.
 *
 * `revision` counts on-disk changes and rides along as a query parameter, so an
 * agent regenerating the file replaces what's on screen instead of leaving a
 * cached copy of the old bytes there.
 */
function MediaPreview({
  src,
  name,
  revision,
}: {
  src: string
  name: string
  revision: number
}) {
  const [failed, setFailed] = useState(false)
  const url =
    revision > 0 ? `${src}${src.includes("?") ? "&" : "?"}v=${revision}` : src
  // A new file — or new bytes for this one — must get its own chance to load.
  useEffect(() => setFailed(false), [url])

  const video = isVideoFile(name)

  if (failed) {
    return (
      <Centered icon={video ? FileVideo : FileAudio} title="Can’t play this file">
        {name} is in a format this browser won’t decode. Open it in a media
        player, or use the terminal to convert it.
      </Centered>
    )
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 overflow-auto bg-card p-6">
      {isImageFile(name) ? (
        <img
          src={url}
          alt={name}
          onError={() => setFailed(true)}
          className="max-h-full max-w-full rounded-md object-contain shadow-sm"
        />
      ) : video ? (
        // `preload="metadata"` so opening a tab costs the header and not the
        // whole file; the raw endpoint answers range requests, so seeking
        // fetches only what it needs.
        <video
          src={url}
          controls
          preload="metadata"
          onError={() => setFailed(true)}
          className="max-h-full max-w-full rounded-md bg-black/90 object-contain shadow-sm"
        />
      ) : (
        <audio
          src={url}
          controls
          preload="metadata"
          onError={() => setFailed(true)}
          // Audio controls have no intrinsic width to speak of, so they'd sit as
          // a lonely strip in the middle of the pane. Give them a column.
          className="w-full max-w-lg"
        />
      )}
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
  splitEnabled: boolean
  splitTooNarrow: boolean
  group: EditorGroup
  onFind: () => void
  onReplace: () => void
  onSplit: () => void
  onMoveToOtherGroup: () => void
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
  splitEnabled,
  splitTooNarrow,
  group,
  onFind,
  onReplace,
  onSplit,
  onMoveToOtherGroup,
  onSetView,
  onSave,
  onDiscard,
  onCopyPath,
  onToggleDiff,
}: EditorMenuProps) {
  const canWrite = file.dirty && !file.saving
  // Already in both groups: there is nowhere left to split it to.
  const alreadySplit = file.groups.length > 1
  const splitLabel = group === 0 ? "Split Right" : "Split Left"
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
        {/* Find/Replace live in the menu as well as on the header button: the
            shortcuts are the fast path, and this is where you look them up. */}
        <DropdownMenuItem onSelect={onFind} disabled={file.diffView}>
          <MagnifyingGlass className="h-4 w-4" />
          Find
          <DropdownMenuShortcut>{FIND_HINT}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onReplace} disabled={file.diffView}>
          <TextAa className="h-4 w-4" />
          Replace
          <DropdownMenuShortcut>{REPLACE_HINT}</DropdownMenuShortcut>
        </DropdownMenuItem>
        {splitEnabled && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={onSplit}
              disabled={alreadySplit || splitTooNarrow}
              // Two 30-column editors are worse than one readable one, so the
              // control says why rather than producing them.
              title={
                splitTooNarrow
                  ? "The panel is too narrow for two editors — widen it first"
                  : alreadySplit
                    ? "Already open in both groups"
                    : undefined
              }
            >
              <SquareSplitHorizontal className="h-4 w-4" />
              {splitLabel}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={onMoveToOtherGroup}
              disabled={splitTooNarrow}
              title={
                splitTooNarrow
                  ? "The panel is too narrow for two editors — widen it first"
                  : undefined
              }
            >
              <ArrowsLeftRight className="h-4 w-4" />
              Move to Other Group
            </DropdownMenuItem>
          </>
        )}
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
