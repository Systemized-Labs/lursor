import { useEffect, useRef } from "react"
import Editor, { DiffEditor } from "@monaco-editor/react"
import type * as Monaco from "monaco-editor"

import "./monaco-setup"
import { defineMonacoTheme, MONACO_THEME_NAME } from "./monaco-theme"
import { languageForFilename } from "./language"

/** Editor font stack, shared by the plain and diff editors. */
const EDITOR_FONT =
  '"Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace'

/** User-toggled display options, shared by the plain and diff editors. */
export interface EditorDisplayOptions {
  lineNumbers: boolean
  wordWrap: boolean
  minimap: boolean
}

/** Map the display toggles onto the Monaco option shape both editors accept. */
function displayOptions(display: EditorDisplayOptions) {
  return {
    minimap: { enabled: display.minimap },
    lineNumbers: (display.lineNumbers ? "on" : "off") as "on" | "off",
    wordWrap: (display.wordWrap ? "on" : "off") as "on" | "off",
  }
}

/**
 * Re-derive the Monaco theme whenever the theme class on `<html>` changes, so
 * both editors track every app theme (not just `.dark`). Shared via a ref the
 * caller wires to Monaco in `beforeMount`.
 */
function useThemeSync(monacoRef: React.MutableRefObject<typeof Monaco | null>) {
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const monaco = monacoRef.current
      if (monaco) monaco.editor.setTheme(defineMonacoTheme(monaco))
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    })
    return () => observer.disconnect()
  }, [monacoRef])
}

interface CodeEditorProps {
  /** Workspace-relative path — also the Monaco model key, so each open file
   *  keeps its own undo history and view state (scroll/cursor). */
  path: string
  value: string
  readOnly?: boolean
  display: EditorDisplayOptions
  onChange: (value: string) => void
  /** Ctrl/Cmd+S inside the editor. */
  onSave: () => void
}

/**
 * A Monaco editor pane themed to follow the app's active theme. One Monaco
 * instance is reused across files: switching the `path` swaps the underlying
 * model (preserving per-file undo/scroll), and a changed `value` is pushed in
 * so live agent edits replace stale content.
 *
 * The editor colors are derived from the active theme's CSS variables (see
 * {@link defineMonacoTheme}), so it tracks every theme — not just `.dark` —
 * and re-syncs whenever the theme class on `<html>` changes.
 */
export function CodeEditor({
  path,
  value,
  readOnly,
  display,
  onChange,
  onSave,
}: CodeEditorProps) {
  const monacoRef = useRef<typeof Monaco | null>(null)
  useThemeSync(monacoRef)

  return (
    <Editor
      path={path}
      value={value}
      theme={MONACO_THEME_NAME}
      language={languageForFilename(path.split("/").pop() ?? path)}
      onChange={(next) => onChange(next ?? "")}
      beforeMount={(monaco) => {
        monacoRef.current = monaco
        defineMonacoTheme(monaco)
      }}
      onMount={(editor, monaco) => {
        editor.addCommand(
          monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
          () => onSave()
        )
      }}
      options={{
        readOnly,
        fontSize: 13,
        fontFamily: EDITOR_FONT,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        renderWhitespace: "selection",
        smoothScrolling: true,
        padding: { top: 8 },
        ...displayOptions(display),
      }}
      loading={
        <p className="text-xs text-muted-foreground">Loading editor…</p>
      }
    />
  )
}

interface DiffCodeEditorProps {
  path: string
  /** The on-disk baseline (left, read-only). */
  original: string
  /** The working buffer (right, editable). */
  modified: string
  display: EditorDisplayOptions
  onChange: (value: string) => void
}

/**
 * A side-by-side diff of the on-disk baseline against the working buffer. The
 * right (modified) pane stays editable and streams edits back through
 * `onChange`, so "Diff View" is a review mode you can keep typing in rather
 * than a dead end. Shares the app-derived theme with {@link CodeEditor}.
 */
export function DiffCodeEditor({
  path,
  original,
  modified,
  display,
  onChange,
}: DiffCodeEditorProps) {
  const monacoRef = useRef<typeof Monaco | null>(null)
  useThemeSync(monacoRef)

  return (
    <DiffEditor
      original={original}
      modified={modified}
      theme={MONACO_THEME_NAME}
      language={languageForFilename(path.split("/").pop() ?? path)}
      beforeMount={(monaco) => {
        monacoRef.current = monaco
        defineMonacoTheme(monaco)
      }}
      onMount={(editor) => {
        const mod = editor.getModifiedEditor()
        mod.onDidChangeModelContent(() => onChange(mod.getValue()))
      }}
      options={{
        fontSize: 13,
        fontFamily: EDITOR_FONT,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        renderSideBySide: true,
        originalEditable: false,
        padding: { top: 8 },
        ...displayOptions(display),
      }}
      loading={
        <p className="text-xs text-muted-foreground">Loading diff…</p>
      }
    />
  )
}
