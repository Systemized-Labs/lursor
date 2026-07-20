import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

// https://vite.dev/config/
export default defineConfig({
  // Relative asset paths so the built app loads correctly from file:// inside
  // Electron (the browser build is unaffected — the dev server ignores base).
  base: "./",
  // Expose the dev server on the LAN (0.0.0.0) so it's reachable from other
  // devices on the network, not just localhost.
  server: { host: true },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
