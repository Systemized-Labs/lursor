import { Navigate, Route, Routes, useParams } from "react-router-dom"

import { AppShell } from "@/components/layout/app-shell"
import { AgentsPage } from "@/pages/agents/agents-page"
import { WorkspaceChatPage } from "@/pages/chat/workspace-chat-page"
import { SkillsPage } from "@/pages/skills/skills-page"
import { ToolsPage } from "@/pages/tools/tools-page"
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
        <Route index element={<Navigate to="/agents" replace />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="skills" element={<SkillsPage />} />
        <Route path="tools" element={<ToolsPage />} />
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
        <Route path="*" element={<Navigate to="/agents" replace />} />
      </Route>
    </Routes>
  )
}

export default App
