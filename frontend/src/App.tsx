import { lazy, Suspense } from "react"
import { Navigate, Route, Routes, useParams } from "react-router-dom"

import { DEFAULT_CATEGORY } from "@/components/settings/settings-categories"
import { SETTINGS_PARAM } from "@/components/settings/use-settings-param"
import { AnalyticsPage } from "@/pages/analytics/analytics-page"
import { ImagePage } from "@/pages/image/image-page"
import { NewAgentPage } from "@/pages/new-agent/new-agent-page"
import { OnboardingGate } from "@/pages/onboarding/onboarding-gate"
import { WelcomePage } from "@/pages/onboarding/welcome-page"
import { VideoPage } from "@/pages/video/video-page"

const DockSpikePage = lazy(() =>
  import("@/pages/spike/dock-spike").then((m) => ({ default: m.DockSpikePage }))
)

/**
 * Land on the home surface with the settings dialog open at `category`.
 *
 * The dialog's state is a query param, so this is the whole implementation —
 * there is no settings *route* to send anyone to any more.
 */
function SettingsRedirect({ category }: { category?: string }) {
  const search = new URLSearchParams({
    [SETTINGS_PARAM]: category ?? DEFAULT_CATEGORY,
  })
  return <Navigate to={`/?${search.toString()}`} replace />
}

/**
 * Opening a workspace now drops straight into its chat surface. The old
 * workspace detail page is gone, so redirect the bare URL to the chat.
 */
function WorkspaceIndexRedirect() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  return <Navigate to={`/workspaces/${workspaceId}/chat`} replace />
}

/**
 * Back-compat for the old per-thread URL. Conversation selection now lives on
 * the single chat surface via the `?c=` param, so redirect there.
 */
function LegacyThreadRedirect() {
  const { workspaceId, threadId } = useParams<{
    workspaceId: string
    threadId: string
  }>()
  return (
    <Navigate to={`/workspaces/${workspaceId}/chat?c=${threadId}`} replace />
  )
}

function App() {
  return (
    <Routes>
      {/* The first-run walkthrough owns the whole viewport (no sidebar, no
          dock), so it sits outside the shell route. Reachable at any time — it
          derives each step's state live, so revisiting it just shows what is
          already set up. */}
      <Route path="welcome" element={<WelcomePage />} />
      {/* THROWAWAY — the Phase 0 dockview spike (docs/PLAN-shell-rewrite.md §8).
          Outside the shell for the same reason the walkthrough is: it owns the
          whole viewport. Lazy so dockview stays out of the entry chunk, which is
          also the arrangement §3.4 asks for in the real thing. Delete with
          src/pages/spike/. */}
      <Route
        path="spike/dock"
        element={
          <Suspense fallback={null}>
            <DockSpikePage />
          </Suspense>
        }
      />
      {/* Everything else renders inside the shell, once setup is done: the gate
          redirects a fresh install to /welcome. */}
      <Route element={<OnboardingGate />}>
        <Route index element={<NewAgentPage />} />
        <Route path="analytics" element={<AnalyticsPage />} />
        {/* Four former destinations are settings-dialog categories now, so their
            routes become redirects onto the home surface with the dialog open.
            They land on `/` rather than staying put because a redirect has to
            choose a path — from inside the app you reach these without
            navigating at all (the rail, ⌘K and ⌘, all set `?settings=` on the
            route you are already on). These exist so an old bookmark, an old
            link in a chat reply, and the ⌘K history of anyone mid-upgrade still
            arrive somewhere correct. */}
        <Route path="settings" element={<SettingsRedirect />} />
        <Route
          path="customization"
          element={<SettingsRedirect category="capabilities" />}
        />
        <Route path="laios" element={<SettingsRedirect category="laios" />} />
        <Route
          path="schedules"
          element={<SettingsRedirect category="schedules" />}
        />
        {/* Its own destination rather than a LAIOS tab: generating a clip is a
            minutes-long job you come back to, not part of managing the box. */}
        <Route path="video" element={<VideoPage />} />
        {/* Its own destination beside Video rather than a tab inside it: they
            share a gateway and a card grid but nothing else — one is a job API
            measured in minutes, the other a synchronous call measured in
            seconds, with different knobs and a different model roster. */}
        <Route path="image" element={<ImagePage />} />
        {/* Back-compat, two generations deep now: these were top-level pages,
            then `?tab=` on Settings or Customization, and are settings categories
            today. Each one still resolves, in one hop rather than a chain. */}
        <Route
          path="settings/laios"
          element={<SettingsRedirect category="laios" />}
        />
        <Route
          path="providers"
          element={<SettingsRedirect category="providers" />}
        />
        <Route path="github" element={<SettingsRedirect category="github" />} />
        <Route
          path="agents"
          element={<SettingsRedirect category="capabilities" />}
        />
        <Route
          path="prompts"
          element={<SettingsRedirect category="capabilities" />}
        />
        <Route
          path="skills"
          element={<SettingsRedirect category="capabilities" />}
        />
        <Route
          path="tools"
          element={<SettingsRedirect category="capabilities" />}
        />
        <Route
          path="workspaces/:workspaceId"
          element={<WorkspaceIndexRedirect />}
        />
        {/* No element: chat is a *pane* now, and the shell mounts the pane layer
            for any `/workspaces/:id` route. This route exists so the URL still
            resolves — it is the address, not the owner (the plan's §4). */}
        <Route path="workspaces/:workspaceId/chat" element={null} />
        <Route
          path="workspaces/:workspaceId/threads/:threadId"
          element={<LegacyThreadRedirect />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

export default App
