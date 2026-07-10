import { useEffect, useState } from "react"
import Editor from "@monaco-editor/react"

import "./monaco-setup"
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
 * A Monaco editor pane themed to follow the app's light/dark mode. One Monaco
 * instance is reused across files: switching the `path` swaps the underlying
 * model (preserving per-file undo/scroll), and a changed `value` is pushed in
 * so live agent edits replace stale content.
 */
export function CodeEditor({
  path,
  value,
  readOnly,
  onChange,
  onSave,
}: CodeEditorProps) {
  const [theme, setTheme] = useState(() =>
    document.documentElement.classList.contains("dark") ? "vs-dark" : "vs"
  )

  // Follow next-themes' `.dark` class toggle on <html>.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(
        document.documentElement.classList.contains("dark") ? "vs-dark" : "vs"
      )
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
      theme={theme}
      language={languageForFilename(path.split("/").pop() ?? path)}
      onChange={(next) => onChange(next ?? "")}
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
