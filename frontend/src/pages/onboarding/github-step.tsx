import { GitBranch } from "@phosphor-icons/react"
import { useState } from "react"
import { toast } from "sonner"

import { useGitHubConfig, useSaveGitHubConfig } from "@/api/github"
import { Button } from "@/components/ui/button"
import { DotGridLoader } from "@/components/ui/dot-grid-loader"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/**
 * Step two: the GitHub connection. Optional — skipping it only costs the "clone
 * a repo" shortcut in the next step and authenticated git in the terminal.
 *
 * Same personal-access-token exchange as Settings → General, minus the
 * disconnect/update affordances that make no sense before you are connected.
 */
export function GitHubStep({ onDone }: { onDone: () => void }) {
  const { data: config } = useGitHubConfig()
  const save = useSaveGitHubConfig()
  const [token, setToken] = useState("")
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")

  const connected = Boolean(config?.connected)

  async function handleConnect() {
    if (!token.trim()) return
    try {
      const cfg = await save.mutateAsync({
        token: token.trim(),
        name: name.trim() || undefined,
        email: email.trim() || undefined,
      })
      setToken("")
      toast.success(`Connected as @${cfg.login ?? "github"}`)
      onDone()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to connect")
    }
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-xl font-semibold tracking-tight text-foreground">
          Connect GitHub
        </h2>
        <p className="text-sm text-muted-foreground">
          Clone repositories into workspaces, and let agents push and pull from
          the terminal. Optional — you can skip this and add it later.
        </p>
      </div>

      {connected && config ? (
        <div className="flex items-center gap-3 rounded-lg border border-success/40 bg-success/10 px-4 py-3">
          {config.avatar_url ? (
            <img
              src={config.avatar_url}
              alt=""
              className="size-9 rounded-full border border-border"
            />
          ) : (
            <GitBranch className="size-9 text-muted-foreground" />
          )}
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-foreground">
              {config.name || config.login || "GitHub"}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {config.login ? `@${config.login}` : ""}
              {config.email ? ` · ${config.email}` : ""}
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="onboarding-gh-token">Personal access token</Label>
            <Input
              id="onboarding-gh-token"
              type="password"
              autoComplete="off"
              placeholder="ghp_… or github_pat_…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Needs <code className="font-mono">repo</code> scope —{" "}
              <a
                href="https://github.com/settings/tokens"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                create one here
              </a>
              . It lives in a Lursor-only git config; your{" "}
              <code className="font-mono">~/.gitconfig</code> is never touched.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="onboarding-gh-name">Commit name (optional)</Label>
              <Input
                id="onboarding-gh-name"
                placeholder="Ada Lovelace"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="onboarding-gh-email">
                Commit email (optional)
              </Label>
              <Input
                id="onboarding-gh-email"
                type="email"
                placeholder="ada@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
          </div>

          <div className="flex justify-end">
            <Button
              onClick={handleConnect}
              disabled={save.isPending || !token.trim()}
            >
              {save.isPending ? (
                <DotGridLoader size="xs" />
              ) : (
                <GitBranch className="size-4" />
              )}
              Connect
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
