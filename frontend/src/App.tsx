import { lazy, Suspense } from "react"
import { Navigate, Route, Routes, useParams } from "react-router-dom"

import { AnalyticsPage } from "@/pages/analytics/analytics-page"
import { WorkspaceChatPage } from "@/pages/chat/workspace-chat-page"
import { CustomizationPage } from "@/pages/customization/customization-page"
import { ImagePage } from "@/pages/image/image-page"
import { LaiosPage } from "@/pages/laios/laios-page"
import { NewAgentPage } from "@/pages/new-agent/new-agent-page"
import { OnboardingGate } from "@/pages/onboarding/onboarding-gate"
import { WelcomePage } from "@/pages/onboarding/welcome-page"
import { SchedulesPage } from "@/pages/schedules/schedules-page"
import { SettingsPage } from "@/pages/settings/settings-page"
import { VideoPage } from "@/pages/video/video-page"

const DockSpikePage = lazy(() =>
  import("@/pages/spike/dock-spike").then((m) => ({ default: m.DockSpikePage }))
)

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
        <Route path="customization" element={<CustomizationPage />} />
        <Route path="laios" element={<LaiosPage />} />
        <Route path="schedules" element={<SchedulesPage />} />
        <Route path="settings" element={<SettingsPage />} />
        {/* Its own destination rather than a LAIOS tab: generating a clip is a
            minutes-long job you come back to, not part of managing the box. */}
        <Route path="video" element={<VideoPage />} />
        {/* Its own destination beside Video rather than a tab inside it: they
            share a gateway and a card grid but nothing else — one is a job API
            measured in minutes, the other a synchronous call measured in
            seconds, with different knobs and a different model roster. */}
        <Route path="image" element={<ImagePage />} />
        {/* Back-compat: LAIOS graduated from a Providers sub-tab to a top-level
            destination; the old deep link still lands on the page. */}
        <Route
          path="settings/laios"
          element={<Navigate to="/laios" replace />}
        />
        {/* Back-compat: providers/github moved from Customization to Settings. */}
        <Route
          path="providers"
          element={<Navigate to="/settings?tab=providers" replace />}
        />
        <Route
          path="github"
          element={<Navigate to="/settings?tab=general" replace />}
        />
        {/* Back-compat: the old top-level pages now live as tabs. */}
        <Route
          path="agents"
          element={<Navigate to="/customization?tab=agents" replace />}
        />
        <Route
          path="prompts"
          element={<Navigate to="/customization?tab=prompts" replace />}
        />
        <Route
          path="skills"
          element={<Navigate to="/customization?tab=skills" replace />}
        />
        <Route
          path="tools"
          element={<Navigate to="/customization?tab=tools" replace />}
        />
        <Route
          path="workspaces/:workspaceId"
          element={<WorkspaceIndexRedirect />}
        />
        <Route
          path="workspaces/:workspaceId/chat"
          element={<WorkspaceChatPage />}
        />
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
