import { useState } from "react"
import { Link } from "react-router-dom"

import { useServerInfo } from "@/api/fs"
import { UpdateDialog } from "@/components/update/update-dialog"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useDesktopUpdate } from "@/hooks/use-desktop-update"

/**
 * What you're running, and the way back into the first-run walkthrough.
 *
 * Both used to live at the bottom of the Settings page's General tab — the
 * version because "what am I actually running" matters most when reporting a bug,
 * the walkthrough because `/welcome` is otherwise a URL only a fresh install can
 * find. Neither belongs in a category about agents or providers, so they get one
 * of their own.
 *
 * The reference UI puts export / import / reset here too. Omitted: there is no
 * backend for any of the three, and three buttons that need new endpoints are
 * worse than not shipping them.
 */
export function AboutSection() {
  const desktop = useDesktopUpdate()
  const { data: serverInfo } = useServerInfo()
  const [updatesOpen, setUpdatesOpen] = useState(false)

  const backendVersion = serverInfo?.version
  const { state } = desktop
  const updateSummary =
    state.phase === "downloaded"
      ? `Version ${state.version} is downloaded and ready to install.`
      : state.phase === "downloading"
        ? `Downloading ${state.version}… ${state.percent ?? 0}%`
        : state.phase === "available"
          ? `Version ${state.version} is available.`
          : state.phase === "checking"
            ? "Checking for updates…"
            : state.phase === "error"
              ? (state.error ?? "The last update check failed.")
              : state.phase === "unsupported"
                ? (state.note ?? "Updates are not available for this build.")
                : "Lursor is up to date."

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Lursor</CardTitle>
          <CardDescription>
            Self-hosted agent harness with workspaces, live terminal, and git
            review.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Selectable, so it can be pasted straight into an issue. Both versions
              are shown when they can differ: over a remote connection the app and the
              backend are updated independently, and "which halves am I running" is
              exactly the question a bug report needs answered. */}
          <p className="select-text text-sm text-muted-foreground tabular-nums">
            Version {__APP_VERSION__}
            {backendVersion && backendVersion !== __APP_VERSION__ ? (
              <>
                {" · backend "}
                <span className="text-warning">{backendVersion}</span>
              </>
            ) : backendVersion ? (
              ` · backend ${backendVersion}`
            ) : null}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={desktop.check}>
              Check for updates
            </Button>
            <Button variant="outline" size="sm" onClick={() => setUpdatesOpen(true)}>
              Manage updates
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{updateSummary}</p>
        </CardContent>
      </Card>

      {/* The same dialog the window-bar indicator opens. Starting a backend update
          from here is safe: the reconnect watch is signalled through a module-scope
          notify and owned by that always-mounted indicator, so closing Settings
          mid-restart doesn't abandon the poll. */}
      <UpdateDialog
        open={updatesOpen}
        onOpenChange={setUpdatesOpen}
        desktop={desktop}
      />

      <Card>
        <CardHeader>
          <CardTitle>Setup walkthrough</CardTitle>
          <CardDescription>
            Step back through models, GitHub, and your first workspace. It derives
            each step from what exists, so this is a read of what is set up as
            much as a re-run.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild variant="outline" size="sm">
            <Link to="/welcome">Open walkthrough</Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
