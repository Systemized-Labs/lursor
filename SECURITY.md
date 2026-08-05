# Security

## Threat model

Lursor is a **single-user** application. It assumes one trusted operator, has no
tenancy boundary of any kind, and runs in one of two postures:

- **Local (the default).** The backend binds loopback and has **no
  authentication** — every HTTP and WebSocket route is reachable by anything that
  can reach the port. This is what the desktop app starts for you, and what
  `scripts/dev.sh` runs.
- **Remote.** `LURSOR_AUTH_TOKEN` is set, and every route then requires
  `Authorization: Bearer <token>` (WebSockets carry it as a subprotocol, since
  browsers cannot set headers on them). This is what makes a backend on another
  machine possible; see [docs/REMOTE.md](docs/REMOTE.md).

Neither posture is a security boundary *inside* the process. Whoever reaches the
API — with the token, or without one on loopback — should be assumed to have the
privileges of the OS user running it:

- **Arbitrary command execution.** `/api/terminal/ws` hands out a real PTY, and
  agents run shell commands, scripts, and skills in a workspace directory. There
  is no sandbox, container, or syscall filter; agent processes run as the same OS
  user as the backend.
- **Arbitrary filesystem access.** A workspace is a directory on disk. The file
  browser and the agent filesystem tools read and write within it, and a
  sufficiently determined agent is not confined to it.
- **Credentials at rest in plaintext.** Provider API keys (OpenRouter, Tavily,
  Exa, custom providers) and workspace environment variables are stored
  unencrypted in the SQLite database, and injected into agent process
  environments. Anyone who can read the DB file, or call `GET /api/settings`, can
  read them.
- **Permissive CORS.** The backend reflects any request origin
  (`allow_origin_regex=".*"`), so any web page you visit can call the API if it can
  reach the port. This exists so the Vite dev server works on a drifting port; it is
  not a security control. Credentials (`allow_credentials`) are allowed only in the
  unauthenticated posture — with a token set they are switched off, because
  authentication is by header and nothing needs cookies to ride along.
- **Port forwarding.** With a token set, `/api/tunnel` will connect to any port on
  the backend host's loopback interface and pipe it to the caller. That is how
  dev-server previews reach a remote backend. It grants nothing the PTY on the same
  host does not already grant, and it refuses non-loopback destinations, so it
  cannot be used to reach the backend's private network.

## Running it safely

### Locally (no token)

- **Bind to loopback.** Keep the backend on `127.0.0.1`. The desktop app already
  does this. `scripts/dev.sh` binds `0.0.0.0` for convenience (reaching the dev
  UI from a phone on the LAN) — on any network you do not fully control, run
  `uvicorn app.main:app --host 127.0.0.1 --port 8791` instead.
- **Never expose an unauthenticated port**, and do not put one behind a reverse
  proxy or tunnel (ngrok, Cloudflare Tunnel, `ssh -R`) expecting the proxy's auth to
  protect it — the WebSocket PTY and the open settings endpoints make that
  equivalent to publishing a root shell. The backend logs a warning at startup
  whenever it runs without a token, for exactly this reason.

### Remotely (with a token)

- **Set `LURSOR_AUTH_TOKEN` before anything is reachable**, not after. Generate it
  with `python -c "import secrets; print(secrets.token_urlsafe(32))"` — 32 bytes of
  CSPRNG output, and URL-safe so it is also a valid WebSocket subprotocol token.
- **Treat the token as an SSH key to that host.** It is one credential with no
  scopes, no expiry and no revocation beyond changing it and restarting. Anyone
  holding it gets a PTY and every stored provider key.
- **Terminate TLS in front of the backend** (Caddy, nginx, or equivalent) and keep
  the backend itself on loopback. The token is a bearer credential: over plain HTTP
  it is readable by anything on the path, and replayable forever. The desktop app
  refuses to save a `http://` connection to any non-loopback host for this reason.
- **Rotate by changing the variable and restarting.** Saved clients then fail with a
  clear "token rejected", not a silent outage.
- **Scope your API keys.** Use provider keys with spend limits, and assume any
  key you paste into Settings is recoverable in plaintext from the machine.
- **Treat workspaces as trusted input.** Pointing an agent at a repository means
  its contents — README files, source comments, tool output — enter the model's
  context and can attempt prompt injection against an agent that holds shell
  access. Review plans before approving them, and prefer goal mode's approval
  checkpoint for anything destructive.

## Reporting a vulnerability

Please report security issues **privately**, not as a public issue:

1. Open a private report via GitHub Security Advisories:
   <https://github.com/JonathanConn/lursor/security/advisories/new>
2. Include the version or commit, reproduction steps, and what an attacker
   gains.

This is a personal project maintained on a best-effort basis — expect a reply
within a couple of weeks rather than a formal SLA. Findings that amount to
"the unauthenticated API allows X" are already documented above and are known
scope, not vulnerabilities; what is in scope is anything that breaks the
threat model's own assumptions, such as a remote page or repository achieving
code execution or key exfiltration without the operator's involvement.

The token posture adds its own in-scope list: **any way to reach an authenticated
route without the token** — a route that skips the middleware, a WebSocket that
accepts an unauthenticated handshake, a token comparison that leaks its result
through timing, or a way to make the backend disclose the token it was started
with. Those are bugs, not scope.

## Supported versions

Only the latest release receives fixes. There are no backported patches.
