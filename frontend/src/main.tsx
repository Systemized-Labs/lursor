import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { BrowserRouter, HashRouter } from "react-router-dom"

import App from "./App.tsx"
import { ThemeProvider } from "@/components/theme-provider"
import { Toaster } from "@/components/ui/sonner"
import { THEME_NAMES } from "@/lib/themes"
import "./index.css"

// When running inside the Electron shell the app is served from file://, where
// history-based routing breaks. Fall back to hash routing there; the browser
// build keeps clean URLs via BrowserRouter.
const Router = window.electron?.isElectron ? HashRouter : BrowserRouter

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      themes={THEME_NAMES}
    >
      <QueryClientProvider client={queryClient}>
        <Router>
          <App />
        </Router>
        <Toaster />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>
)
