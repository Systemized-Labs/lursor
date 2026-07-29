# Security

## Threat model

Lursor is a **single-user, local-first** application. It assumes one trusted
operator on a trusted machine, and it has no authentication, authorization, or
tenancy boundary of any kind. Every HTTP and WebSocket route is reachable by
anyone who can reach the port.

That is a deliberate scope decision, not an oversight (see the "Status" section
of [AGENTS.md](AGENTS.md)) — but it means the backend must be treated as a
privileged process, equivalent to an open shell on the host:

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
- **Permissive CORS.** The backend reflects any request origin and allows
  credentials (`allow_origin_regex=".*"`), so any web page you visit can call the
  API if it can reach the port. This exists so the Vite dev server works on a
  drifting port; it is not a security control.

## Running it safely

- **Bind to loopback.** Keep the backend on `127.0.0.1`. The desktop app already
  does this. `scripts/dev.sh` binds `0.0.0.0` for convenience (reaching the dev
  UI from a phone on the LAN) — on any network you do not fully control, run
  `uvicorn app.main:app --host 127.0.0.1 --port 8791` instead.
- **Never expose the port to the internet**, and do not put it behind a
  reverse proxy or tunnel (ngrok, Cloudflare Tunnel, `ssh -R`) expecting the
  proxy's auth to protect it — the WebSocket PTY and the unauthenticated
  settings endpoints make any exposure equivalent to publishing a root shell.
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

## Supported versions

Only the latest release receives fixes. There are no backported patches.
