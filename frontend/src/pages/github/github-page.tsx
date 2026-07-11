import { GitBranch, ArrowsClockwise, Plugs } from "@phosphor-icons/react"
import { useState } from "react"
import { toast } from "sonner"

import {
  useDisconnectGitHub,
  useGitHubConfig,
  useSaveGitHubConfig,
} from "@/api/github"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DotGridLoader } from "@/components/ui/dot-grid-loader"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

const DESCRIPTION =
  "Connect a GitHub account with a personal access token to clone repositories into workspaces and push/pull from the terminal."

export function GitHubPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { data: config, isLoading } = useGitHubConfig()
  const connected = Boolean(config?.connected)

  return (
    <div className="space-y-6">
      {embedded ? (
        <p className="text-sm text-muted-foreground">{DESCRIPTION}</p>
      ) : null}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : connected && config ? (
        <ConnectedCard config={config} />
      ) : (
        <ConnectForm />
      )}
    </div>
  )
}

/** Token + identity form shown when no account is connected. */
function ConnectForm() {
  const save = useSaveGitHubConfig()
  const [token, setToken] = useState("")
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")

  async function handleConnect() {
    if (!token.trim()) {
      toast.error("A token is required")
      return
    }
    try {
      const cfg = await save.mutateAsync({
        token: token.trim(),
        name: name.trim() || undefined,
        email: email.trim() || undefined,
      })
      toast.success(`Connected as @${cfg.login ?? "github"}`)
      setToken("")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to connect")
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GitBranch className="h-5 w-5" />
          Connect GitHub
        </CardTitle>
        <CardDescription>
          Paste a{" "}
          <a
            href="https://github.com/settings/tokens"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            personal access token
          </a>{" "}
          with <code className="font-mono">repo</code> scope. It is stored in a
          Lursor-only git config so clone, push, and pull work here and in the
          terminal — your <code className="font-mono">~/.gitconfig</code> is never
          touched.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2">
          <Label htmlFor="gh-token">Personal access token</Label>
          <Input
            id="gh-token"
            type="password"
            autoComplete="off"
            placeholder="ghp_… or github_pat_…"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="gh-name">Commit name (optional)</Label>
            <Input
              id="gh-name"
              placeholder="Ada Lovelace"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="gh-email">Commit email (optional)</Label>
            <Input
              id="gh-email"
              type="email"
              placeholder="ada@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Sets <code className="font-mono">user.name</code> /{" "}
          <code className="font-mono">user.email</code> for commits in Lursor.
          Leave blank to keep your existing git identity.
        </p>
        <div className="flex justify-end">
          <Button onClick={handleConnect} disabled={save.isPending}>
            {save.isPending ? (
              <DotGridLoader size="xs" />
            ) : (
              <GitBranch className="h-4 w-4" />
            )}
            Connect
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/** Status card shown when an account is connected. */
function ConnectedCard({
  config,
}: {
  config: NonNullable<ReturnType<typeof useGitHubConfig>["data"]>
}) {
  const disconnect = useDisconnectGitHub()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [showForm, setShowForm] = useState(false)

  async function handleDisconnect() {
    try {
      await disconnect.mutateAsync()
      toast.success("GitHub disconnected")
      setConfirmOpen(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to disconnect")
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              {config.avatar_url ? (
                <img
                  src={config.avatar_url}
                  alt=""
                  className="h-10 w-10 rounded-full border border-border"
                />
              ) : (
                <GitBranch className="h-10 w-10" />
              )}
              <div className="min-w-0">
                <CardTitle className="truncate">
                  {config.name || config.login || "GitHub"}
                </CardTitle>
                <CardDescription className="truncate">
                  {config.login ? `@${config.login}` : ""}
                  {config.email ? ` · ${config.email}` : ""}
                </CardDescription>
              </div>
            </div>
            <Badge variant="secondary">Connected</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Token {config.token_hint ?? "set"} · stored in Lursor&apos;s isolated
            git config (<code className="font-mono">~/.lursor/git</code>).
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setShowForm((v) => !v)}>
              <ArrowsClockwise className="h-4 w-4" />
              {showForm ? "Hide" : "Update token"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => setConfirmOpen(true)}
            >
              <Plugs className="h-4 w-4" />
              Disconnect
            </Button>
          </div>
          {showForm ? (
            <div className="border-t border-border pt-4">
              <ConnectForm />
            </div>
          ) : null}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Disconnect GitHub"
        description="This removes Lursor's stored token and git config. Cloned workspaces stay on disk but git operations will no longer be authenticated."
        confirmLabel="Disconnect"
        destructive
        loading={disconnect.isPending}
        onConfirm={handleDisconnect}
      />
    </>
  )
}
