// Local port forwarding to a remote backend, so previews work.
//
// This is the client half of `ssh -L`, carried over the API connection the app is
// already authenticated on. The server half is `backend/app/api/tunnel.py`, whose
// docstring covers why forwarding beats an HTTP reverse proxy for dev servers.
//
// The shape: for a port the remote backend reports a dev server on, listen on the
// *same* port number on 127.0.0.1 here. Each accepted TCP connection opens its own
// WebSocket to `/api/tunnel?port=N` and pipes bytes both ways. Nothing rewrites
// anything, so root-absolute asset paths, HMR sockets and framework assumptions
// about `location.port` all keep working — the dev server appears to be local,
// because as far as the renderer is concerned it is.
//
// Keeping the port number identical matters more than it looks. Vite prints
// `localhost:5173`, the agent says "your app is on :5173", and the Preview panel
// remembers addresses per tab in localStorage. Remapping would make all three lie.
// When the port is genuinely taken on this machine we fall back to an ephemeral one
// and report it back, which the panel then uses.

const net = require("node:net")

/**
 * Token subprotocol prefix. Third copy of this string, and they must agree:
 * `SUBPROTOCOL_PREFIX` in `backend/app/auth.py` is the authority, `WS_TOKEN_PREFIX`
 * in `frontend/src/api/client.ts` is the renderer's.
 *
 * Used here even though this is Node and *could* set an `Authorization` header,
 * because the header option on the global `WebSocket` is a non-standard undici
 * extension rather than part of the API. One authentication path for every socket
 * the app opens is worth more than saving a string concatenation.
 */
const WS_TOKEN_PREFIX = "lursor.bearer."

/**
 * Out-of-band "the forwarded service closed its end" marker. Must match
 * `_EOF_MARKER` in `backend/app/api/tunnel.py`, whose comment explains why the
 * stream ends this way rather than with the backend simply closing.
 */
const EOF_MARKER = "eof"

/** Active forwards, keyed by the *remote* port. */
const forwards = new Map()

/** Resolved once by {@link configure}; null in local mode, where nothing is forwarded. */
let config = null

/**
 * Point the forwarder at a connection.
 * @param {{ apiBase: string, token: string } | null} next Null tears everything down.
 */
function configure(next) {
  closeAll()
  config = next
}

/** The `ws(s)://…/tunnel` URL for a remote port. */
function tunnelUrl(remotePort) {
  const url = new URL(`${config.apiBase.replace(/\/$/, "")}/tunnel`)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.searchParams.set("port", String(remotePort))
  return url.toString()
}

/**
 * Bridge one accepted TCP socket to its own tunnel WebSocket.
 *
 * Backpressure is the only subtle part: a dev server can produce faster than the
 * WebSocket drains, so the TCP socket is paused whenever the socket's buffer grows
 * and resumed when it empties. Without it, a large asset can balloon memory in the
 * main process.
 */
function bridge(socket, remotePort) {
  const ws = new WebSocket(tunnelUrl(remotePort), [`${WS_TOKEN_PREFIX}${config.token}`])
  ws.binaryType = "arraybuffer"

  // Bytes that arrive before the socket finishes opening. Small — a TCP client
  // usually waits for the server to speak first, but an HTTP request line can beat
  // the handshake.
  const pending = []
  let open = false

  const closeTunnel = () => {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close()
    }
  }

  /**
   * The forwarded service is done: end the socket **gracefully**.
   *
   * `end()` flushes whatever is still queued and then sends FIN. `destroy()` here
   * instead is an abortive close that discards buffered writes and reaches the
   * client as `ECONNRESET` / "socket hang up" — which breaks every response whose
   * length is defined by the connection closing rather than by `content-length`.
   * `HTTP/1.0` replies and anything sending `Connection: close` rely on exactly
   * that, and a lost tail reads as a corrupt page rather than a networking bug.
   */
  const endSocket = () => {
    if (!socket.destroyed) socket.end()
  }

  socket.on("data", (chunk) => {
    if (open) {
      ws.send(chunk)
      // `bufferedAmount` is bytes queued but not yet flushed to the network.
      if (ws.bufferedAmount > 1 << 20) {
        socket.pause()
        const drain = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return clearInterval(drain)
          if (ws.bufferedAmount < 1 << 18) {
            clearInterval(drain)
            socket.resume()
          }
        }, 20)
      }
    } else {
      pending.push(chunk)
    }
  })

  ws.addEventListener("open", () => {
    open = true
    for (const chunk of pending) ws.send(chunk)
    pending.length = 0
  })

  ws.addEventListener("message", (event) => {
    const data = event.data

    // Text frames are out-of-band control, never payload — the stream itself is
    // binary. Today there is exactly one: the backend telling us the forwarded
    // service closed its end (see `_EOF_MARKER` in backend/app/api/tunnel.py).
    // Writing it into the socket as data would corrupt the response.
    if (typeof data === "string") {
      if (data === EOF_MARKER) {
        // Graceful: flush what the dev server already sent, then FIN. Closing the
        // tunnel from this side is deliberate — the backend cannot close without
        // discarding frames it has queued.
        endSocket()
        closeTunnel()
      }
      return
    }

    socket.write(
      Buffer.from(data instanceof ArrayBuffer ? data : new Uint8Array(data))
    )
  })

  ws.addEventListener("close", endSocket)
  ws.addEventListener("error", (err) => {
    // A refused tunnel is routine: the dev server exited but the panel still has
    // its port. Log at debug volume and let the TCP side see a closed connection,
    // which is what the browser needs to show its own error.
    console.log(
      `[forward] tunnel error on remote port ${remotePort}: ${err?.message ?? "unknown"}`
    )
    // An errored tunnel has no orderly end to relay, so this one is abortive on
    // purpose: a half-written response should look broken, not complete.
    socket.destroy()
  })

  socket.on("error", () => {
    socket.destroy()
    closeTunnel()
  })
  socket.on("close", closeTunnel)
  // Deliberately no `end` handler: the listener runs with `allowHalfOpen`, so a
  // client that finished sending its request leaves this socket writable and the
  // response still flows back. Ending the tunnel here would truncate it.
}

/**
 * Forward `remotePort` on the backend host to this machine.
 *
 * Idempotent: asking twice for the same port returns the same local port rather
 * than opening a second listener. Resolves to the local port, or null when there
 * is nothing to forward (local mode) or the listener could not be opened.
 *
 * @returns {Promise<number | null>}
 */
function forward(remotePort) {
  if (!config) return Promise.resolve(null)
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    return Promise.resolve(null)
  }

  const existing = forwards.get(remotePort)
  if (existing) return Promise.resolve(existing.localPort)

  return new Promise((resolve) => {
    // `allowHalfOpen` because this is a byte proxy, not a server: by default Node
    // ends a socket as soon as the peer sends FIN, which for a client that closes
    // its write side after sending a request would throw away the response.
    const server = net.createServer({ allowHalfOpen: true }, (socket) =>
      bridge(socket, remotePort)
    )

    const listenOn = (port, isFallback) => {
      server.once("error", (err) => {
        if (err.code === "EADDRINUSE" && !isFallback) {
          // Something local already holds the port — the user's own dev server, or
          // a forward from a previous run that hasn't been reaped. Take an
          // ephemeral port instead and let the caller know it moved.
          console.log(
            `[forward] local port ${remotePort} is busy; using an ephemeral port`
          )
          listenOn(0, true)
          return
        }
        console.error(
          `[forward] could not listen for remote port ${remotePort}:`,
          err?.message ?? err
        )
        resolve(null)
      })
      server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
        const localPort = server.address().port
        forwards.set(remotePort, { server, localPort })
        console.log(`[forward] 127.0.0.1:${localPort} -> remote 127.0.0.1:${remotePort}`)
        resolve(localPort)
      })
    }

    listenOn(remotePort, false)
  })
}

/** Stop forwarding one remote port. */
function close(remotePort) {
  const entry = forwards.get(remotePort)
  if (!entry) return
  forwards.delete(remotePort)
  entry.server.close()
}

/** Stop everything — on connection switch, window close, and quit. */
function closeAll() {
  for (const remotePort of [...forwards.keys()]) close(remotePort)
}

module.exports = { close, closeAll, configure, forward }
