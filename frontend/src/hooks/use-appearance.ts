import { useCallback, useEffect, useState } from "react"

import {
  applyFontFamily,
  applyFontSize,
  clampFontSize,
  FONT_FAMILY_STORAGE_KEY,
  FONT_SIZE_STORAGE_KEY,
  getStoredFontFamily,
  getStoredFontSize,
} from "@/lib/appearance"

/**
 * Reads and writes the user's font family/size preferences. State is seeded
 * from localStorage (already applied pre-paint by the inline script in
 * index.html) and re-applied + persisted on every change. A `storage` listener
 * keeps other tabs/windows in sync.
 */
export function useAppearance() {
  const [fontFamily, setFontFamilyState] = useState(getStoredFontFamily)
  const [fontSize, setFontSizeState] = useState(getStoredFontSize)

  const setFontFamily = useCallback((value: string) => {
    setFontFamilyState(value)
    localStorage.setItem(FONT_FAMILY_STORAGE_KEY, value)
    applyFontFamily(value)
  }, [])

  const setFontSize = useCallback((px: number) => {
    const next = clampFontSize(px)
    setFontSizeState(next)
    localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(next))
    applyFontSize(next)
  }, [])

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === FONT_FAMILY_STORAGE_KEY) {
        const next = getStoredFontFamily()
        setFontFamilyState(next)
        applyFontFamily(next)
      } else if (e.key === FONT_SIZE_STORAGE_KEY) {
        const next = getStoredFontSize()
        setFontSizeState(next)
        applyFontSize(next)
      }
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [])

  return { fontFamily, setFontFamily, fontSize, setFontSize }
}
