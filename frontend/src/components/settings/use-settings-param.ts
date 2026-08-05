import { useCallback } from "react"
import { useSearchParams } from "react-router-dom"

import { DEFAULT_CATEGORY } from "@/components/settings/settings-categories"

/** The query param the dialog mirrors itself to. */
export const SETTINGS_PARAM = "settings"

/**
 * Settings-dialog state, held in the URL rather than in React.
 *
 * Deliberately a query param and not a route. A route would mean navigating
 * *away* from whatever you were doing to change a model — the exact trade the
 * plan's §1 calls wrong — and once panes are the layout (Phase 4) it would also
 * mean tearing down the layout to show a modal over it. As a param it deep-links,
 * survives a reload, and opens over any route without changing which route that
 * is.
 *
 * Replace, not push: flipping between categories should not fill the back stack
 * with settings history. Opening and closing *are* pushed, so the back gesture
 * closes the dialog, which is what a modal in a URL should do.
 */
export function useSettingsParam() {
  const [searchParams, setSearchParams] = useSearchParams()
  const category = searchParams.get(SETTINGS_PARAM)
  const open = category !== null

  const openSettings = useCallback(
    (next?: string) => {
      setSearchParams((prev) => {
        const params = new URLSearchParams(prev)
        params.set(SETTINGS_PARAM, next ?? DEFAULT_CATEGORY)
        return params
      })
    },
    [setSearchParams]
  )

  const selectCategory = useCallback(
    (next: string) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev)
          params.set(SETTINGS_PARAM, next)
          return params
        },
        { replace: true }
      )
    },
    [setSearchParams]
  )

  const closeSettings = useCallback(() => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev)
      params.delete(SETTINGS_PARAM)
      return params
    })
  }, [setSearchParams])

  return { open, category, openSettings, selectCategory, closeSettings }
}
