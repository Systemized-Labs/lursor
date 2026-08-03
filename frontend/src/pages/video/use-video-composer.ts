import { useCallback, useState } from "react"

import type { LaiosVideoJob } from "@/api/types"
import {
  DEFAULT_SETTINGS,
  settingsFromRequest,
  type VideoSettings,
} from "./video-settings"

/**
 * The composer's form state, held above the composer itself.
 *
 * Lifted out of the panel so a run card can put a past run *back* into it —
 * "reuse" is the page's main editing loop (a clip is rarely right first try, and
 * the fix is usually one knob), and that only works if the card and the form
 * share state.
 */
export interface VideoComposer {
  model: string
  setModel: (value: string) => void
  prompt: string
  setPrompt: (value: string) => void
  settings: VideoSettings
  /** Patch one or more knobs; everything else keeps its value. */
  update: (patch: Partial<VideoSettings>) => void
  advancedOpen: boolean
  toggleAdvanced: () => void
  /**
   * Bumped every time a run is loaded in, so the composer can scroll itself into
   * view and focus the prompt. A counter rather than a boolean: loading a second
   * run right after the first has to re-fire, and there is no natural moment to
   * reset a flag.
   */
  focusTick: number
  loadRun: (job: LaiosVideoJob) => void
}

export function useVideoComposer(): VideoComposer {
  const [model, setModel] = useState("")
  const [prompt, setPrompt] = useState("")
  const [settings, setSettings] = useState<VideoSettings>(DEFAULT_SETTINGS)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [focusTick, setFocusTick] = useState(0)

  const update = useCallback((patch: Partial<VideoSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }))
  }, [])

  const loadRun = useCallback((job: LaiosVideoJob) => {
    setModel(job.model)
    setPrompt(job.prompt)
    setSettings(settingsFromRequest(job.request))
    // Open the knobs: you reuse a run to change one of them, and leaving them
    // folded away would hide the thing you came to edit.
    setAdvancedOpen(true)
    setFocusTick((tick) => tick + 1)
  }, [])

  return {
    model,
    setModel,
    prompt,
    setPrompt,
    settings,
    update,
    advancedOpen,
    toggleAdvanced: useCallback(() => setAdvancedOpen((open) => !open), []),
    focusTick,
    loadRun,
  }
}
