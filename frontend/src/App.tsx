import { Navigate, Route, Routes } from "react-router-dom"

import { AppShell } from "@/components/layout/app-shell"
import { AgentsPage } from "@/pages/agents/agents-page"
import { ChatPage } from "@/pages/chat/chat-page"
import { SkillsPage } from "@/pages/skills/skills-page"
import { ToolsPage } from "@/pages/tools/tools-page"
import { WorkspaceDetailPage } from "@/pages/workspaces/workspace-detail-page"
import { WorkspacesPage } from "@/pages/workspaces/workspaces-page"

function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/agents" replace />} />
        <Route path="agents" element={<AgentsPage />} />
        <Route path="skills" element={<SkillsPage />} />
        <Route path="tools" element={<ToolsPage />} />
        <Route path="workspaces" element={<WorkspacesPage />} />
        <Route
          path="workspaces/:workspaceId"
          element={<WorkspaceDetailPage />}
        />
        <Route
          path="workspaces/:workspaceId/threads/:threadId"
          element={<ChatPage />}
        />
        <Route path="*" element={<Navigate to="/agents" replace />} />
      </Route>
    </Routes>
  )
}

export default App
