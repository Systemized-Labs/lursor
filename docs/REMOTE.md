# Running the backend on another machine

The desktop app normally starts its own backend and stops it when you quit. Close
the laptop and the agents stop with it.

A **remote connection** splits the two: the backend runs somewhere that stays on — a
VPS, or a desktop in the corner — and the app becomes a thin client against it. Long
runs, goal loops and schedules keep going with your laptop shut, and you pick up
where they got to next time you open it.

Everything the app does works this way: chat streaming, the terminal, the file tree,
git diffs, uploads, and dev-server previews. Two things change, and both are covered
below: the backend needs a token, and workspace folders are chosen from the remote
filesystem rather than an OS dialog.

> Read [SECURITY.md](../SECURITY.md) first if you are putting this on the public
> internet. The token is the only thing between a stranger and a shell on that box.

## 1. Install the backend on the remote host

One command. It clones the source, builds the environment (fetching a suitable Python
— the backend pins `>=3.11,<3.13` and distros routinely ship something outside that),
generates a token, and hands the backend to the platform's supervisor so it survives a
reboot and a crash:

```bash
curl -fsSL https://raw.githubusercontent.com/JonathanConn/lursor/main/scripts/install-server.sh | sh
```

It prints the token at the end — that is what the desktop app authenticates with.
Re-run the same command to upgrade: it pulls, re-syncs and restarts the service,
keeping your database, workspaces and token.

Env overrides: `LURSOR_DIR` (default `~/lursor`), `LURSOR_PORT` (default `8791`),
`LURSOR_REF`, `LURSOR_REPO`. Remove it again with `--uninstall`, which stops the
service and leaves your code and data alone.

The service itself is managed by `lursor-service`, a CLI in the backend:

```bash
cd ~/lursor/backend
uv run lursor-service status      # supervisor state, linger, and whether it answers
uv run lursor-service token       # print the token again
uv run lursor-service install --rotate-token   # new token; logs out every client
uv run lursor-service uninstall
```

On Linux that is a systemd `--user` unit — a *user* unit because the backend is an
ordinary program running as you, with your keys and repos; nothing about it wants
root. `install` will tell you to run `sudo loginctl enable-linger <user>` if it isn't
already set: without lingering your systemd instance only exists while you are logged
in, so the backend would not start after a reboot until someone signed in. That is the
one step needing root, and the installer won't do it for you.

On macOS it is a LaunchAgent, which starts at **login, not at boot**. A Mac that must
serve from cold with nobody signed in needs a root-owned LaunchDaemon — not something
this tool installs.

Logs: `journalctl --user -u lursor-backend -f` on Linux,
`~/Library/Logs/lursor-backend.log` on macOS.

### What supervision does and does not give you

It means **the backend comes back** — after a reboot, a crash, an OOM kill. It does
**not** mean the work continues. Run state lives in memory
(`app/agents/chat_run_manager.py`), so a turn that was in flight when the service
restarted is marked `stopped` on the next boot and you resend it yourself. Schedules,
and anything started after the restart, are unaffected.

That is the honest shape of it: supervision protects you from the machine rebooting
overnight, not from a crash three minutes into a long run.

### Doing it by hand instead

If you'd rather not run an installer, the backend is just uvicorn with a token:

```bash
git clone https://github.com/JonathanConn/lursor.git && cd lursor/backend && uv sync
LURSOR_AUTH_TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')" \
  uv run uvicorn app.main:app --host 127.0.0.1 --port 8791
```

Use that generator rather than a passphrase you invent: 32 bytes of CSPRNG output,
and its URL-safe alphabet is also a valid WebSocket subprotocol token, which is how
the token reaches WebSocket routes since browsers cannot put headers on them.

Bind loopback — the TLS proxy in the next step is what faces the network. Without
`LURSOR_AUTH_TOKEN` the backend starts completely unauthenticated and logs a warning
saying so; check for that line if a connection is rejected, because it means the token
you are sending is being compared against nothing. And note that command dies with
your shell, which is the whole reason the installer exists.

## 2. Put TLS in front of it

A bearer token over plain HTTP is readable by anything on the path and replayable
forever, so the app refuses to save a `http://` connection to any non-loopback host.
With Caddy, that is the whole configuration:

```
lursor.example.com {
    reverse_proxy 127.0.0.1:8791
}
```

Caddy gets a certificate automatically and proxies WebSockets without extra
configuration. Behind nginx you will need the usual `Upgrade`/`Connection` headers,
and `proxy_read_timeout` raised well past the default — agent turns and idle PTYs
both hold a connection open far longer than 60 seconds.

Point DNS at the host, open 443, and leave 8791 closed.

## 3. Add the connection in the app

Launch Lursor and open **Switch Connection…** (the app menu on macOS, File
elsewhere). Choose **Add a remote backend** and give it:

- **Name** — whatever you want to see in the window bar.
- **Address** — `https://lursor.example.com`.
- **Token** — printed by the installer, or `uv run lursor-service token`.

It connects on save. From then on that connection is remembered and reused at launch,
and the picker only appears when you ask for it or when the saved connection can't be
reached. `This Mac` is always in the list, so switching back to a local backend is
one click.

Connections are stored in `~/.lursor/connections.json`, with tokens encrypted using
your OS keychain (`safeStorage`). Where no keychain is available the token is stored
in plaintext and the app logs a warning saying so.

## Keeping the tunnel alive

The backend is already supervised by step 1. If you reach it over an SSH tunnel rather
than https, that tunnel is a second thing that fails independently — it dies when your
laptop sleeps or changes network, and nothing brings it back.

Unlike the backend, Lursor does not manage this for you: the shipped path is https
direct, and the tunnel is something you set up outside the app. On macOS a LaunchAgent
is the least fragile way to do it.

Two ssh config entries, because sharing one is a trap — the forward would be attached to
every `ssh` you run, and each would fail with `Address already in use` while the
tunnel holds the port:

```
Host lursor-server
    HostName 192.168.1.50
    User jon
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes

# Used by the launchd agent and nothing else.
Host lursor-tunnel
    HostName 192.168.1.50
    User jon
    IdentityFile ~/.ssh/id_ed25519
    IdentitiesOnly yes
    LocalForward 8792 127.0.0.1:8791
    # Make a dead link terminate in ~45s so the agent can replace it, instead of
    # leaving a socket that accepts connections and then hangs.
    ServerAliveInterval 15
    ServerAliveCountMax 3
    ExitOnForwardFailure yes
```

Key-based auth is required — a launchd job has no terminal to type a password into.
`ssh-copy-id lursor-server` once, then confirm `ssh -o BatchMode=yes lursor-server`
works.

`~/Library/LaunchAgents/local.lursor.tunnel.plist` runs
`/usr/bin/ssh -N -o BatchMode=yes lursor-tunnel` with `RunAtLoad`, `KeepAlive` and a
`ThrottleInterval` of 10. `KeepAlive` is what makes this survive sleep: ssh exits when
the link dies and launchd starts a new one.

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/local.lursor.tunnel.plist
```

### What recovery actually looks like

Waking the laptop takes roughly a minute end to end: ~45s for `ServerAliveInterval`
to notice the link is dead, then ~10s for launchd to start a replacement. During that
window the app shows "Reconnecting to `<name>`…" in the window bar and then
re-attaches on its own — no restart, and agent runs, dev servers and schedules on the
server were never interrupted.

Add the connection as `http://127.0.0.1:8792` (loopback, so the plain-http guard
allows it; SSH is what encrypts the hop). If the tunnel is down when you launch, you
get the picker with "Could not reach …" and can pick **This Mac** instead.

## Previews of remote dev servers

A dev server the agent starts on the remote host listens on that host's
`127.0.0.1:5173`, which your laptop cannot reach — and on a VPS only 443 is open
anyway.

The app forwards the port instead. When the backend reports a dev server, the app
opens a local listener on **the same port number** and pipes it over the API
connection to the remote loopback port (`/api/tunnel`). `localhost:5173` on your
machine then *is* the remote dev server: absolute asset paths, hot module reload and
anything reading `location.port` all work, because nothing is being rewritten.

You get the same address the dev server printed, so the Preview panel, the agent's
description of what it started, and the "open in browser" button all agree. If that
port is genuinely busy on your machine, the forward moves to a free one and the panel
follows it.

Two consequences worth knowing:

- Previews only work in the **desktop app**. Forwarding needs a process outside the
  browser sandbox.
- Preview addresses are remembered in their remote form (`localhost:5173`), not as
  whichever local port a forward happened to land on — so they still resolve next
  launch.

## Choosing workspace folders

`POST /workspaces/pick-folder` opens a real OS folder dialog, which a headless host
has no display for. The backend reports this in `GET /api/server-info`
(`can_pick_folder: false`) and the app switches to browsing the remote filesystem
instead: navigate it, type a path directly, and directories holding a `.git` are
marked as repositories.

## Testing it without a VPS

A second backend on another port, with a token, is indistinguishable from a remote
one to everything except TLS. Loopback is exempt from the https requirement precisely
so this works:

```bash
# a "remote" backend, with its own database
cd backend
LURSOR_AUTH_TOKEN='test-token' LURSOR_DATA_DIR=/tmp/lursor-remote \
  uv run uvicorn app.main:app --port 8799
```

Then add `http://127.0.0.1:8799` in the app with the token `test-token`.

## What is not supported

- **Browser access.** The backend serves the API only. A browser cannot attach an
  `Authorization` header to a navigation or an iframe load, so reaching a
  token-protected backend needs the desktop app.
- **Multiple users.** One token, one operator. Everyone who has the token is the same
  person as far as the backend is concerned.
- **In-app updates over a remote connection.** They are skipped: updating the client
  would not touch the backend your agents are running on, and quitting to install
  would drop the connection mid-run. Update the client from a local connection, and
  the remote backend with `git pull` on that host.
