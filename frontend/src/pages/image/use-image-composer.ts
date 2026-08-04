import { useCallback, useMemo, useState } from "react"

import type { LaiosImageRun } from "@/api/types"
import {
  defaultSettings,
  profileFor,
  settingsFromRequest,
  toSubmittable,
  type ImageProfile,
  type ImageSettings,
} from "./image-settings"

/**
 * The composer's form state, held above the composer itself.
 *
 * Lifted out of the panel so a run card can put a past run *back* into it —
 * "reuse" is the page's main editing loop, and on this page it does double duty:
 * the fastest way to compare two image models is to reuse a run and change only
 * the model.
 */
export interface ImageComposer {
  model: string
  /**
   * Also re-derives the per-model knobs — see {@link chooseModel}.
   */
  setModel: (value: string) => void
  /** The profile for the selected model, which is what shapes every control. */
  profile: ImageProfile
  prompt: string
  setPrompt: (value: string) => void
  settings: ImageSettings
  /** Patch one or more knobs; everything else keeps its value. */
  update: (patch: Partial<ImageSettings>) => void
  advancedOpen: boolean
  toggleAdvanced: () => void
  /**
   * Bumped every time a run is loaded in, so the composer can scroll itself into
   * view and focus the prompt. A counter rather than a boolean: loading a second
   * run right after the first has to re-fire, and there is no natural moment to
   * reset a flag.
   */
  focusTick: number
  loadRun: (run: LaiosImageRun) => void
}

export function useImageComposer(): ImageComposer {
  const [model, setModelState] = useState("")
  const [prompt, setPrompt] = useState("")
  const [settings, setSettings] = useState<ImageSettings>(() =>
    defaultSettings(profileFor(""))
  )
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [focusTick, setFocusTick] = useState(0)

  const profile = useMemo(() => profileFor(model), [model])

  const update = useCallback((patch: Partial<ImageSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }))
  }, [])

  /**
   * Switch model, and move the knobs that belong to the model with it.
   *
   * Steps and guidance are reset to the new model's defaults rather than carried
   * over, which is deliberate and the opposite of what "don't lose my input"
   * would suggest. The two recipes disagree by 5× on what a step count means:
   * carrying 9 steps from Z-Image onto Qwen renders a visibly undercooked image,
   * and carrying 50 back the other way costs 40 pointless steps on a checkpoint
   * distilled to 9. A number that is right for one model is wrong for the other,
   * so it follows the model. Size, seed, negative prompt and format are
   * genuinely the operator's and are kept.
   */
  const setModel = useCallback((next: string) => {
    setModelState(next)
    setSettings((prev) => {
      const nextProfile = profileFor(next)
      return toSubmittable(
        {
          ...prev,
          steps: nextProfile.defaultSteps,
          guidance: nextProfile.guidance,
        },
        nextProfile
      )
    })
  }, [])

  const loadRun = useCallback((run: LaiosImageRun) => {
    setModelState(run.model)
    setPrompt(run.prompt)
    // Read against the run's *own* model, then clamped to it — a run reloaded
    // verbatim from a different model's request would carry knobs this one
    // rejects or ignores.
    const runProfile = profileFor(run.model)
    setSettings(toSubmittable(settingsFromRequest(run.request, runProfile), runProfile))
    // Open the knobs: you reuse a run to change one of them, and leaving them
    // folded away would hide the thing you came to edit.
    setAdvancedOpen(true)
    setFocusTick((tick) => tick + 1)
  }, [])

  return {
    model,
    setModel,
    profile,
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
