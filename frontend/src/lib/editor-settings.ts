/**
 * Editor preferences — Monaco display toggles that persist across sessions.
 *
 * These mirror the font settings in {@link file://./appearance.ts}: each is
 * stored in `localStorage` and read back on load. Unlike the font settings they
 * aren't applied to `<html>` — the code editor reads them and hands them to
 * Monaco. Kept as one JSON blob so adding a toggle doesn't mean a new key.
 */

export interface EditorSettings {
  /** Show the line-number gutter. */
  lineNumbers: boolean
  /** Soft-wrap long lines to the viewport width. */
  wordWrap: boolean
  /** Show the minimap overview ruler on the right edge. */
  minimap: boolean
  /** Save dirty buffers automatically a short beat after the last keystroke. */
  autoSave: boolean
}

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  lineNumbers: true,
  wordWrap: false,
  minimap: false,
  autoSave: false,
}

export const EDITOR_SETTINGS_STORAGE_KEY = "lursor-editor-settings"

/** Idle delay (ms) before an auto-save fires after the last keystroke. */
export const AUTO_SAVE_DELAY_MS = 800

/** Read the persisted editor settings, merged over defaults. */
export function getStoredEditorSettings(): EditorSettings {
  if (typeof localStorage === "undefined") return DEFAULT_EDITOR_SETTINGS
  try {
    const raw = localStorage.getItem(EDITOR_SETTINGS_STORAGE_KEY)
    if (!raw) return DEFAULT_EDITOR_SETTINGS
    const parsed = JSON.parse(raw) as Partial<EditorSettings>
    // Merge over defaults so a toggle added in a later version picks up its
    // default rather than reading back `undefined` for existing users.
    return { ...DEFAULT_EDITOR_SETTINGS, ...parsed }
  } catch {
    return DEFAULT_EDITOR_SETTINGS
  }
}

/** Persist the editor settings blob. */
export function storeEditorSettings(settings: EditorSettings) {
  if (typeof localStorage === "undefined") return
  localStorage.setItem(EDITOR_SETTINGS_STORAGE_KEY, JSON.stringify(settings))
}
