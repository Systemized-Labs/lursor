import { useEffect } from "react"
import { Navigate } from "react-router-dom"

import { AppShell } from "@/components/layout/app-shell"
import { DotGridLoader } from "@/components/ui/dot-grid-loader"
import {
  completeOnboarding,
  isOnboardingComplete,
  useOnboardingStatus,
} from "./use-onboarding"

/**
 * Stands in front of the app shell on a fresh install and sends the user to
 * `/welcome`.
 *
 * The localStorage flag is read synchronously, so the common case — a returning
 * user — renders the shell immediately and fires no extra queries. Only an
 * install that has never finished the walkthrough pays for the check.
 */
export function OnboardingGate() {
  if (isOnboardingComplete()) return <AppShell />
  return <FirstRunCheck />
}

/**
 * The unflagged case: decide from real state rather than the flag. An install
 * that predates the walkthrough (or one set up from `.env`) already has a model
 * and a workspace, so it is silently marked done and never sees the welcome
 * screen.
 */
function FirstRunCheck() {
  const status = useOnboardingStatus()
  const settled = !status.loading
  const alreadySetUp = status.modelReady && status.workspaceReady

  useEffect(() => {
    if (settled && alreadySetUp) completeOnboarding()
  }, [settled, alreadySetUp])

  if (!settled) {
    // Brief, and only during first run. Painted on `bg-background` so a dark
    // theme doesn't flash white while the checks resolve.
    return (
      <div className="flex min-h-svh items-center justify-center bg-background">
        <DotGridLoader />
      </div>
    )
  }

  if (alreadySetUp) return <AppShell />
  return <Navigate to="/welcome" replace />
}
