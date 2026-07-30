import { ArrowLeft, ArrowRight } from "@phosphor-icons/react"
import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"

import lursorIcon from "@/assets/lursor_icon.png"
import { useOpenRouterSettings } from "@/api/settings"
import type { Workspace } from "@/api/types"
import { Button } from "@/components/ui/button"
import { DotGridLoader } from "@/components/ui/dot-grid-loader"
import { GitHubStep } from "./github-step"
import { ModelStep } from "./model-step"
import { ReadyStep } from "./ready-step"
import { StepRail } from "./step-rail"
import { completeOnboarding, useOnboardingStatus } from "./use-onboarding"
import { WorkspaceStep } from "./workspace-step"

const STEP_LABELS = ["Model", "GitHub", "Workspace", "Ready"] as const
const LAST = STEP_LABELS.length - 1

/**
 * The first-run walkthrough at `/welcome`: bring a model, connect GitHub, open a
 * workspace, then a look at the room before landing in it.
 *
 * Full-screen and outside the AppShell on purpose — there is nothing useful in
 * the sidebar or dock until these are done, and the steps read better with the
 * width. Progress is never stored: each step's state is derived live (see
 * `useOnboardingStatus`), so the page is safe to revisit at any time — every
 * satisfied step is simply already ticked.
 */
export function WelcomePage() {
  const navigate = useNavigate()
  const status = useOnboardingStatus()
  const { data: openrouter } = useOpenRouterSettings()

  // Null until the first read lands, so the opening step isn't chosen from
  // half-loaded state (and then visibly corrected).
  const [step, setStep] = useState<number | null>(null)
  const [created, setCreated] = useState<Workspace | null>(null)

  useEffect(() => {
    if (status.loading || step !== null) return
    setStep(
      !status.modelReady
        ? 0
        : !status.githubReady
          ? 1
          : !status.workspaceReady
            ? 2
            : LAST
    )
  }, [status, step])

  const done = [
    status.modelReady,
    status.githubReady,
    status.workspaceReady || Boolean(created),
    false,
  ]

  function finish() {
    completeOnboarding()
    const workspaceId = created?.id ?? status.firstWorkspaceId
    navigate(workspaceId ? `/workspaces/${workspaceId}/chat` : "/", {
      replace: true,
    })
  }

  function advance() {
    setStep((prev) => Math.min((prev ?? 0) + 1, LAST))
  }

  if (step === null) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background">
        <DotGridLoader />
      </div>
    )
  }

  // A model is the one hard prerequisite, so the rail only unlocks the later
  // steps once one exists — except for wherever the user already stands, which
  // must always stay clickable.
  const maxIndex = Math.max(step, status.modelReady ? LAST : 0)

  return (
    <div className="min-h-svh bg-background">
      {/* The whole stack is centred as one block (rather than a `flex-1` body
          that strands the footer at the bottom of a tall window), so each step's
          controls sit next to its content whatever its height. */}
      <div className="mx-auto flex min-h-svh w-full max-w-2xl flex-col justify-center gap-8 px-4 py-10 sm:px-6">
        <header className="space-y-6">
          <div className="flex items-center gap-2.5">
            <img
              src={lursorIcon}
              alt=""
              className="size-8 shrink-0 rounded-md object-contain"
            />
            <span className="text-sm font-medium text-foreground">Lursor</span>
            <span className="text-sm text-muted-foreground">
              · the self-hosted control room for AI agents
            </span>
          </div>
          <StepRail
            steps={STEP_LABELS.map((label, index) => ({
              id: label,
              label,
              done: done[index],
            }))}
            activeIndex={step}
            maxIndex={maxIndex}
            onSelect={setStep}
          />
        </header>

        <main>
          {step === 0 ? (
            <ModelStep
              ready={status.modelReady}
              keySource={openrouter?.source}
              onDone={advance}
            />
          ) : step === 1 ? (
            <GitHubStep onDone={advance} />
          ) : step === 2 ? (
            <WorkspaceStep
              githubReady={status.githubReady}
              onCreated={(ws) => {
                setCreated(ws)
                advance()
              }}
            />
          ) : (
            <ReadyStep workspaceName={created?.name} />
          )}
        </main>

        <footer className="flex items-center justify-between gap-3">
          {step > 0 ? (
            <Button variant="ghost" onClick={() => setStep(step - 1)}>
              <ArrowLeft className="size-4" />
              Back
            </Button>
          ) : (
            <span />
          )}

          {/* One forward control at a time: "Continue" once the step is
              satisfied, an honest "Skip for now" while it isn't. */}
          {step === LAST ? (
            <Button onClick={finish}>
              {created || status.firstWorkspaceId
                ? "Open workspace"
                : "Start using Lursor"}
              <ArrowRight className="size-4" />
            </Button>
          ) : done[step] ? (
            <Button onClick={advance}>
              Continue
              <ArrowRight className="size-4" />
            </Button>
          ) : (
            <Button variant="ghost" onClick={advance}>
              Skip for now
              <ArrowRight className="size-4" />
            </Button>
          )}
        </footer>
      </div>
    </div>
  )
}
