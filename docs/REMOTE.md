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

The same source and the same command as [running from source](../README.md#run-from-source)
— there is no separate server build:

```bash
git clone https://github.com/JonathanConn/lursor.git
cd lursor/backend
uv sync
```

## 2. Generate a token

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

Use that generator, not a passphrase you invent. It is 32 bytes of CSPRNG output,
and its URL-safe alphabet is also a valid WebSocket subprotocol token — which is how
the token reaches WebSocket routes, since browsers cannot put headers on them.

Keep it somewhere you can paste from once. The app stores it in your OS keychain
after that.

## 3. Run it, bound to loopback

```bash
LURSOR_AUTH_TOKEN='<the token>' \
uv run uvicorn app.main:app --host 127.0.0.1 --port 8791
```

Loopback, deliberately — the TLS proxy in the next step is what faces the network.

Without `LURSOR_AUTH_TOKEN` the backend starts completely unauthenticated and logs a
warning saying so. Check for that line if a connection is rejected: it means the
token you are sending is being compared against nothing.

Keeping it running across reboots is your call — a systemd unit, `tmux`, or whatever
you already use for services on that host. Lursor ships no supervisor.

## 4. Put TLS in front of it

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

## 5. Add the connection in the app

Launch Lursor and open **Switch Connection…** (the app menu on macOS, File
elsewhere). Choose **Add a remote backend** and give it:

- **Name** — whatever you want to see in the window bar.
- **Address** — `https://lursor.example.com`.
- **Token** — from step 2.

It connects on save. From then on that connection is remembered and reused at launch,
and the picker only appears when you ask for it or when the saved connection can't be
reached. `This Mac` is always in the list, so switching back to a local backend is
one click.

Connections are stored in `~/.lursor/connections.json`, with tokens encrypted using
your OS keychain (`safeStorage`). Where no keychain is available the token is stored
in plaintext and the app logs a warning saying so.

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
