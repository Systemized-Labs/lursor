import { Navigate, Route, Routes, useParams } from "react-router-dom"

import { AppShell } from "@/components/layout/app-shell"
import { WorkspaceChatPage } from "@/pages/chat/workspace-chat-page"
import { CustomizationPage } from "@/pages/customization/customization-page"
import { WorkspaceDetailPage } from "@/pages/workspaces/workspace-detail-page"
import { WorkspacesPage } from "@/pages/workspaces/workspaces-page"

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
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/customization" replace />} />
        <Route path="customization" element={<CustomizationPage />} />
        {/* Back-compat: the old top-level pages now live as tabs. */}
        <Route
          path="agents"
          element={<Navigate to="/customization?tab=agents" replace />}
        />
        <Route
          path="skills"
          element={<Navigate to="/customization?tab=skills" replace />}
        />
        <Route
          path="tools"
          element={<Navigate to="/customization?tab=tools" replace />}
        />
        <Route path="workspaces" element={<WorkspacesPage />} />
        <Route path="workspaces/:workspaceId" element={<WorkspaceDetailPage />} />
        <Route
          path="workspaces/:workspaceId/chat"
          element={<WorkspaceChatPage />}
        />
        <Route
          path="workspaces/:workspaceId/threads/:threadId"
          element={<LegacyThreadRedirect />}
        />
        <Route path="*" element={<Navigate to="/customization" replace />} />
      </Route>
    </Routes>
  )
}

export default App
