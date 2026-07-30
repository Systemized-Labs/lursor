import {
  ArrowClockwise,
  CheckCircle,
  Copy,
  Plugs,
  PlugsConnected,
  Terminal,
} from "@phosphor-icons/react"
import { toast } from "sonner"

import { useHermesIntegration } from "@/api/integrations"
import type { HermesIntegration } from "@/api/types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { copyToClipboard } from "@/lib/utils"

/** A shell command shown for the operator to run, with a copy button. */
function CommandRow({ command, label }: { command: string; label: string }) {
  async function handleCopy() {
    const ok = await copyToClipboard(command)
    if (ok) {
      toast.success(`${label} copied`)
    } else {
      toast.error("Could not copy — select the text and copy it manually")
    }
  }

  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-3">
      <Terminal className="h-4 w-4 shrink-0 text-muted-foreground" />
      <code className="flex-1 overflow-x-auto whitespace-nowrap font-mono text-sm text-foreground">
        {command}
      </code>
      <Button
        variant="ghost"
        size="sm"
        onClick={handleCopy}
        aria-label={`Copy ${label}`}
      >
        <Copy className="h-4 w-4" />
      </Button>
    </div>
  )
}

/**
 * Which step of the pairing the user is on. Ordered, because each state's fix is
 * the previous one's next action and only one command should be shown at a time.
 */
function stage(
  data: HermesIntegration
): "absent" | "not-installed" | "not-enabled" | "connected" {
  if (!data.hermes_present) return "absent"
  if (!data.plugin_installed) return "not-installed"
  if (!data.plugin_enabled) return "not-enabled"
  return "connected"
}

function StatusBadge({ data }: { data: HermesIntegration }) {
  const current = stage(data)
  if (current === "connected") {
    return (
      <Badge variant="secondary" className="gap-1">
        <CheckCircle className="h-3.5 w-3.5" />
        Connected
      </Badge>
    )
  }
  if (current === "absent") {
    return <Badge variant="outline">Hermes not found</Badge>
  }
  return (
    <Badge variant="outline">
      {current === "not-installed" ? "Not installed" : "Not enabled"}
    </Badge>
  )
}

/**
 * The Hermes pairing card.
 *
 * Lursor already reads skills out of `~/.hermes`; this plugin is the reverse
 * direction — it lets Hermes drive Lursor. Deliberately a *detect and instruct*
 * flow rather than a one-click install: Lursor's rule for another tool's
 * directory is read in place, never write, and quietly editing Hermes's config
 * from here would break it. So we detect the state, show the one command that
 * moves it forward, and re-check when the window regains focus.
 */
export function IntegrationsSection() {
  const { data, isLoading, refetch, isFetching } = useHermesIntegration()

  return (
    <Card>
      <CardHeader>
        {/* The description is long, so the left column takes the slack and wraps
            inside itself — otherwise the status badge wraps to its own line and
            leaves a gap under the text. */}
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              {data && stage(data) === "connected" ? (
                <PlugsConnected className="h-5 w-5" />
              ) : (
                <Plugs className="h-5 w-5" />
              )}
              Hermes
            </CardTitle>
            <CardDescription>
              Let{" "}
              <a
                href="https://hermes-agent.nousresearch.com"
                target="_blank"
                rel="noreferrer"
                className="text-foreground underline underline-offset-2"
              >
                Hermes
              </a>{" "}
              drive this Lursor instance — delegate work to your agents, follow
              goal runs, schedule them, and read back the diff. Lursor already
              reads skills from{" "}
              <code className="font-mono text-muted-foreground">
                ~/.hermes/skills
              </code>
              ; this is the
              other direction.
            </CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isLoading ? null : data ? <StatusBadge data={data} /> : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
              aria-label="Re-check Hermes"
            >
              <ArrowClockwise className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {isLoading || !data ? (
          <div className="space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">{data.detail}</p>

            {stage(data) === "absent" ? (
              <p className="text-sm text-muted-foreground">
                Looked in{" "}
                <code className="font-mono text-foreground">{data.home}</code>.
                Install Hermes,
                then re-check.
              </p>
            ) : null}

            {stage(data) === "not-installed" ? (
              <CommandRow
                command={data.install_command}
                label="Install command"
              />
            ) : null}

            {stage(data) === "not-enabled" ? (
              <CommandRow command={data.enable_command} label="Enable command" />
            ) : null}

            {data.update_available ? (
              <CommandRow
                command={`${data.install_command} --force`}
                label="Upgrade command"
              />
            ) : null}

            {stage(data) !== "absent" && stage(data) !== "connected" ? (
              <p className="text-sm text-muted-foreground">
                Hermes loads plugins once per process, so restart it afterwards —
                a new session in a running Hermes will not pick this up.
              </p>
            ) : null}

            {stage(data) === "connected" ? (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">
                  Ask Hermes to{" "}
                  <span className="text-foreground">
                    &ldquo;list my Lursor workspaces&rdquo;
                  </span>{" "}
                  to check the wiring, or run{" "}
                  <code className="font-mono text-foreground">
                    hermes lursor status
                  </code>{" "}
                  in a
                  terminal.
                </p>
                <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
                  <dt className="text-muted-foreground">Version</dt>
                  <dd className="text-foreground">
                    {data.installed_version || "unknown"}
                    {data.plugin_linked ? " (local checkout)" : ""}
                  </dd>
                  <dt className="text-muted-foreground">Plugin</dt>
                  <dd className="font-mono text-foreground">
                    {data.home}/plugins/lursor
                  </dd>
                  {data.cli_path ? (
                    <>
                      <dt className="text-muted-foreground">CLI</dt>
                      <dd className="font-mono text-foreground">
                        {data.cli_path}
                      </dd>
                    </>
                  ) : null}
                </dl>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  )
}
