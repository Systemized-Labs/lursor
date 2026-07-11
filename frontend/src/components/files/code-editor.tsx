import { useEffect, useRef } from "react"
import Editor from "@monaco-editor/react"
import type * as Monaco from "monaco-editor"

import "./monaco-setup"
import { defineMonacoTheme, MONACO_THEME_NAME } from "./monaco-theme"
import { languageForFilename } from "./language"

interface CodeEditorProps {
  /** Workspace-relative path — also the Monaco model key, so each open file
   *  keeps its own undo history and view state (scroll/cursor). */
  path: string
  value: string
  readOnly?: boolean
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
  onChange,
  onSave,
}: CodeEditorProps) {
  const monacoRef = useRef<typeof Monaco | null>(null)

  // Re-derive the Monaco theme whenever the theme class on <html> changes.
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
  }, [])

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
        fontFamily:
          '"Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        renderWhitespace: "selection",
        smoothScrolling: true,
        padding: { top: 8 },
      }}
      loading={
        <p className="text-xs text-muted-foreground">Loading editor…</p>
      }
    />
  )
}
