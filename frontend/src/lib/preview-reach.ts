/**
 * Making a dev server's address reachable from wherever the UI is being viewed.
 *
 * A dev server reports itself on a loopback address, which is only correct for
 * something running on the same machine as the server. Three situations, and the
 * preview panel has to handle all of them:
 *
 * - **Same machine.** `http://localhost:5173` is already right. Nothing to do.
 * - **Another device on the LAN** (a phone hitting the Mac's IP). Loopback would
 *   resolve to the phone, so rewrite the host to whichever host served the page.
 * - **A remote backend.** The dev server is on `127.0.0.1:5173` *inside a VPS*, and
 *   no amount of host rewriting reaches it — the port isn't exposed. The desktop
 *   app forwards it to a local port instead (`electron/port-forward.cjs`), so the
 *   address becomes `http://127.0.0.1:<local>`.
 *
 * Two kinds of URL therefore exist, and keeping them apart is what this module is
 * for. The **canonical** URL is what the dev server reports and the user types — it
 * is what gets persisted, compared and displayed. The **reachable** URL is what an
 * iframe or the system browser is given. They are the same string in the common
 * case, and only the reachable one is ever loaded.
 *
 * Persisting the canonical form matters: a forwarded port is picked per session, so
 * a remembered `127.0.0.1:58608` would point at nothing on the next launch. It also
 * fixes the same latent problem for the LAN case, where a URL saved on a phone
 * carried that phone's view of the network back to the desktop.
 */

/** Loopback hosts a dev server reports itself on. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"])

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host)
}

/**
 * The browser's hostname, but only when it's a real network host worth preferring
 * over a loopback address — i.e. the UI is being viewed from another device (a
 * phone hitting the Mac's LAN IP). Returns `null` on the Electron / `file:` desktop
 * shell or when already on localhost, so those keep loopback URLs untouched.
 */
function originHost(): string | null {
  if (typeof window === "undefined") return null
  const host = window.location.hostname
  if (!host || isLoopbackHost(host)) return null
  return host
}

/**
 * Normalize a user-typed address into a loadable URL, or `null` if it can't be made
 * into one. A bare host/port (`localhost:3000`) gets an `http://` scheme so the
 * common "paste the port the dev server printed" case just works.
 */
export function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`
  try {
    return new URL(withScheme).toString()
  } catch {
    return null
  }
}

/**
 * True when two addresses mean the same server.
 *
 * Compared canonically, so it is a plain string comparison after normalization —
 * which is what keeps the "already loaded" dedup, the server chips and the
 * starting→ready auto-reload agreeing with each other no matter how either address
 * ends up being reached.
 */
export function sameUrl(a: string, b: string): boolean {
  const na = normalizeUrl(a)
  const nb = normalizeUrl(b)
  if (na === null || nb === null) return false
  return na === nb
}

// --- Port forwarding (remote backends only) ---------------------------------

/** Remote port → local port, for forwards this session has already opened. */
const forwarded = new Map<number, number>()
/** In-flight requests, so two callers asking at once share one forward. */
const pending = new Map<number, Promise<number | null>>()

function isRemote(): boolean {
  return typeof window !== "undefined" && window.electron?.isRemote === true
}

/**
 * Ensure a port on the backend host is forwarded to this machine, resolving to the
 * local port. Resolves to `null` when there is nothing to forward — a local backend,
 * or a plain browser, where the port is either already reachable or unreachable by
 * any means available here.
 */
export function ensureForward(port: number): Promise<number | null> {
  if (!isRemote() || !window.electron?.forwardPort) return Promise.resolve(null)

  const existing = forwarded.get(port)
  if (existing !== undefined) return Promise.resolve(existing)

  const inFlight = pending.get(port)
  if (inFlight) return inFlight

  const request = window.electron
    .forwardPort(port)
    .then((local) => {
      if (typeof local === "number") forwarded.set(port, local)
      return local
    })
    .catch(() => null)
    .finally(() => pending.delete(port))

  pending.set(port, request)
  return request
}

/** A forward already established for `port`, without opening one. */
export function knownForward(port: number): number | undefined {
  return forwarded.get(port)
}

// --- Canonical → reachable --------------------------------------------------

/** Rewrite a loopback URL's host, preserving scheme, port and path. */
function withHost(raw: string, host: string, port?: number): string | null {
  try {
    const u = new URL(raw)
    u.hostname = host
    if (port !== undefined) u.port = String(port)
    return u.toString()
  } catch {
    return null
  }
}

/**
 * The address to actually load for a canonical one.
 *
 * Async because a remote backend may need a port forwarded first, which is an IPC
 * round trip. Everything else resolves immediately.
 */
export async function toReachableUrl(canonical: string): Promise<string> {
  if (!canonical) return ""

  let parsed: URL
  try {
    parsed = new URL(canonical)
  } catch {
    return canonical
  }

  // A real host is either already reachable or deliberately chosen; either way it
  // is not ours to rewrite.
  if (!isLoopbackHost(parsed.hostname)) return canonical

  if (isRemote()) {
    // Default to the scheme's port when the URL omits one, since that is what the
    // server is actually listening on.
    const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80))
    const local = await ensureForward(port)
    // A forward that couldn't be opened leaves the canonical address, which fails
    // visibly in the iframe. Better than a blank pane that looks like nothing
    // happened.
    if (local === null) return canonical
    return withHost(canonical, "127.0.0.1", local) ?? canonical
  }

  const host = originHost()
  if (!host) return canonical
  return withHost(canonical, host) ?? canonical
}

/**
 * The synchronous half of {@link toReachableUrl}, for a render pass that cannot
 * await: uses a forward only if one is already open. Callers that need the forward
 * to exist should await {@link toReachableUrl} instead.
 *
 * Returns `""` — meaning "not reachable yet, don't load anything" — when a remote
 * address needs a forward that isn't open. Returning the un-forwarded address would
 * be worse than returning nothing: it loads, fails, and has to correct itself in
 * front of the user.
 */
export function reachableIfKnown(canonical: string): string {
  if (!canonical) return ""
  try {
    const parsed = new URL(canonical)
    if (!isLoopbackHost(parsed.hostname)) return canonical
    if (isRemote()) {
      const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80))
      const local = knownForward(port)
      return local === undefined
        ? ""
        : (withHost(canonical, "127.0.0.1", local) ?? canonical)
    }
    const host = originHost()
    return host ? (withHost(canonical, host) ?? canonical) : canonical
  } catch {
    return canonical
  }
}
