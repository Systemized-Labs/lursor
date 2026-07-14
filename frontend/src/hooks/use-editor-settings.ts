import { useCallback, useEffect, useState } from "react"

import {
  EDITOR_SETTINGS_STORAGE_KEY,
  getStoredEditorSettings,
  storeEditorSettings,
  type EditorSettings,
} from "@/lib/editor-settings"

/**
 * Reads and writes the user's editor display preferences (line numbers, word
 * wrap, minimap, auto save). Seeded from localStorage, persisted on every
 * change, and kept in sync across windows via a `storage` listener — mirrors
 * {@link file://./use-appearance.ts}.
 */
export function useEditorSettings() {
  const [settings, setSettings] = useState(getStoredEditorSettings)

  const setSetting = useCallback(
    <K extends keyof EditorSettings>(key: K, value: EditorSettings[K]) => {
      setSettings((prev) => {
        const next = { ...prev, [key]: value }
        storeEditorSettings(next)
        return next
      })
    },
    []
  )

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === EDITOR_SETTINGS_STORAGE_KEY) {
        setSettings(getStoredEditorSettings())
      }
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [])

  return { settings, setSetting }
}
