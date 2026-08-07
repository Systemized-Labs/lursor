// Saved backend connections: this machine, plus any remotes.
//
// Lursor's desktop app has always owned its backend — spawn uvicorn on a loopback
// port, talk to it, kill it on quit. A remote connection keeps everything about
// that except the spawning: the app becomes a thin client against a backend on a
// VPS, so agents keep working with the laptop shut.
//
// Two decisions worth knowing before changing anything here:
//
// The local connection is *synthesized*, never persisted. A fresh install has no
// config file at all and boots straight into local mode, exactly as it did before
// any of this existed — no picker, no migration, nothing to go wrong for the many
// users who will never add a remote. It also means the local entry can't be
// deleted or corrupted into an unbootable state.
//
// Tokens are encrypted with Electron's `safeStorage` (the OS keychain) when it is
// available. `AGENTS.md` lists keychain storage for secrets as deliberately
// deferred, and that still holds for provider API keys — those live in the backend
// database, and encrypting them there solves a different problem. This token is
// different in kind: it is a shell on a remote host, it sits in a plaintext file in
// the user's home directory, and `safeStorage` costs about ten lines.

const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const crypto = require("node:crypto")
const { safeStorage } = require("electron")

/** Same directory the packaged backend keeps its writable state in. */
const CONFIG_DIR = path.join(os.homedir(), ".lursor")
const CONFIG_PATH = path.join(CONFIG_DIR, "connections.json")

/** Stable id of the synthesized local connection. */
const LOCAL_ID = "local"

/**
 * @typedef {object} Connection
 * @property {string} id
 * @property {string} name
 * @property {"local" | "remote"} kind
 * @property {string} [url]    Origin of the remote backend, e.g. https://box.example.com
 * @property {string} [token]  Bearer token, decrypted. Never written in this form.
 */

/** The connection to this machine's own bundled backend. */
function localConnection() {
  const name =
    process.platform === "darwin"
      ? "This Mac"
      : process.platform === "win32"
        ? "This PC"
        : "This machine"
  return { id: LOCAL_ID, name, kind: "local" }
}

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

function encryptToken(token) {
  if (!token) return { token: "" }
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { tokenEnc: safeStorage.encryptString(token).toString("base64") }
    }
  } catch (err) {
    console.error("[connections] safeStorage encrypt failed:", err?.message ?? err)
  }
  // No keychain (a Linux box with no libsecret provider, most often). Storing the
  // token in plaintext is still better than refusing to work — the file is in the
  // user's own home directory, which is also where their SSH keys are — but say so,
  // because it is a meaningful downgrade and the user may be able to fix it.
  console.warn(
    "[connections] OS keychain unavailable; storing the remote token in plaintext at " +
      CONFIG_PATH
  )
  return { token }
}

function decryptToken(entry) {
  if (entry.tokenEnc) {
    try {
      return safeStorage.decryptString(Buffer.from(entry.tokenEnc, "base64"))
    } catch (err) {
      // Happens for real: the keychain entry is per-OS-user and per-machine, so a
      // copied home directory or a reset login keychain leaves ciphertext nothing
      // can open. Treat it as "no token" so the connection prompts for a new one
      // instead of failing with something inscrutable.
      console.error("[connections] could not decrypt saved token:", err?.message ?? err)
      return ""
    }
  }
  return entry.token ?? ""
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function readFile() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8")
    const parsed = JSON.parse(raw)
    return {
      lastUsedId: typeof parsed.lastUsedId === "string" ? parsed.lastUsedId : LOCAL_ID,
      remotes: Array.isArray(parsed.connections) ? parsed.connections : [],
    }
  } catch {
    // Missing (the common case — a fresh install) or unparseable. Either way the
    // answer is the same: local only.
    return { lastUsedId: LOCAL_ID, remotes: [] }
  }
}

function writeFile(state) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ version: 1, lastUsedId: state.lastUsedId, connections: state.remotes }, null, 2),
      // The file holds a credential even when safeStorage worked (the ciphertext is
      // only as private as the keychain), so keep it owner-readable.
      { mode: 0o600 }
    )
  } catch (err) {
    console.error("[connections] could not save:", err?.message ?? err)
  }
}

// ---------------------------------------------------------------------------
// URL handling
// ---------------------------------------------------------------------------

/** An IPv4 literal's four octets, or null when the host isn't one. */
function ipv4Octets(hostname) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  if (!match) return null
  const octets = match.slice(1).map(Number)
  return octets.every((n) => n <= 255) ? octets : null
}

/** `url.hostname` without the brackets Node keeps around IPv6 literals. */
function bareHost(hostname) {
  return String(hostname).replace(/^\[|\]$/g, "").toLowerCase()
}

/** This machine — nothing addressed here reaches a wire. */
function isLoopbackHost(hostname) {
  const host = bareHost(hostname)
  if (host === "localhost" || host === "::1") return true
  const octets = ipv4Octets(host)
  return octets ? octets[0] === 127 : false
}

/**
 * Hosts that cannot be routed off the local network.
 *
 * The RFC 1918 ranges, link-local (169.254/16, fe80::/10), IPv6 unique-local
 * (fc00::/7), and the two name suffixes that are link-scoped by definition — mDNS
 * `.local` and the RFC 8375 home zone. Deliberately literal: a name that merely
 * *resolves* to a private address is not included, because that resolution is not
 * something this check can pin down and DNS rebinding is exactly the trick it would
 * be inviting.
 */
function isPrivateHost(hostname) {
  const host = bareHost(hostname)
  if (isLoopbackHost(host)) return true
  if (host.endsWith(".local") || host.endsWith(".home.arpa")) return true

  const octets = ipv4Octets(host)
  if (octets) {
    const [a, b] = octets
    if (a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    return false
  }

  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10), by first hextet.
  return /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host)
}

/**
 * Validate and normalize a remote backend address to its origin.
 *
 * Accepts what a user is likely to paste — a bare host, a full origin, or the API
 * base with `/api` already on it — and returns just the origin, because that is
 * what {@link apiBaseFor} builds from.
 *
 * `insecure` is set when the result will carry the token in cleartext, so callers
 * can say so. It is advice, not a refusal; see the scheme rule below.
 *
 * @returns {{ url: string, insecure: boolean } | { error: string }}
 */
function normalizeRemoteUrl(input) {
  const trimmed = String(input ?? "").trim()
  if (!trimmed) return { error: "Enter the address of the remote backend." }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`

  let url
  try {
    url = new URL(withScheme)
  } catch {
    return { error: `"${trimmed}" is not a valid address.` }
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { error: "The address must start with https:// or http://." }
  }

  // The token authenticates every request and grants a shell on the backend's host,
  // so plain HTTP across the public internet is refused outright — there is no
  // version of that which is a good idea.
  //
  // A private address is allowed, with a warning wherever it is shown. It is the
  // ordinary home-lab setup (a box on the LAN, no domain, so no certificate a CA
  // will issue), and refusing it pushed people toward an SSH tunnel they had to
  // babysit or a self-signed cert they had to trust machine-wide. The exposure is
  // real but bounded: anyone who can already ARP-spoof your subnet can read the
  // token. Loopback is the same rule's easy case — nothing leaves the machine.
  if (url.protocol === "http:" && !isPrivateHost(url.hostname)) {
    return {
      error:
        "Plain http:// would send the token across the public internet in the " +
        "clear. Use https:// (put the backend behind a TLS reverse proxy — see " +
        "docs/REMOTE.md).",
    }
  }

  return {
    url: url.origin,
    insecure: url.protocol === "http:" && !isLoopbackHost(url.hostname),
  }
}

/** The API base a connection's origin implies. */
function apiBaseFor(origin) {
  return `${String(origin).replace(/\/+$/, "")}/api`
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Every connection, local first, tokens decrypted. @returns {Connection[]} */
function list() {
  const { remotes } = readFile()
  return [
    localConnection(),
    ...remotes
      .filter((entry) => entry && typeof entry.id === "string" && entry.url)
      .map((entry) => ({
        id: entry.id,
        name: entry.name || entry.url,
        kind: "remote",
        url: entry.url,
        token: decryptToken(entry),
      })),
  ]
}

/** @returns {Connection | null} */
function get(id) {
  return list().find((c) => c.id === id) ?? null
}

/** The connection to try first: whatever was used last, falling back to local. */
function lastUsed() {
  const { lastUsedId } = readFile()
  return get(lastUsedId) ?? localConnection()
}

function setLastUsed(id) {
  const state = readFile()
  // Nothing to remember when local is the only connection there is: recording it
  // would create a config file on a machine that has never used this feature, and
  // "no file at all" is the state a fresh install should keep.
  if (id === LOCAL_ID && state.remotes.length === 0) return
  state.lastUsedId = id
  writeFile(state)
}

/** True when a remote has ever been added — the only reason to show a picker. */
function hasRemotes() {
  return readFile().remotes.length > 0
}

/**
 * Add or update a remote.
 *
 * @returns {{ connection: Connection } | { error: string }}
 */
function save({ id, name, url, token }) {
  const normalized = normalizeRemoteUrl(url)
  if ("error" in normalized) return normalized

  const trimmedToken = String(token ?? "").trim()
  if (!trimmedToken) {
    return {
      error:
        "A remote backend needs its token (the LURSOR_AUTH_TOKEN it was started with).",
    }
  }

  const state = readFile()
  const entry = {
    id: id || crypto.randomUUID(),
    name: String(name ?? "").trim() || new URL(normalized.url).host,
    url: normalized.url,
    ...encryptToken(trimmedToken),
  }

  const index = state.remotes.findIndex((r) => r.id === entry.id)
  if (index === -1) state.remotes.push(entry)
  else state.remotes[index] = entry
  writeFile(state)

  return {
    connection: {
      id: entry.id,
      name: entry.name,
      kind: "remote",
      url: entry.url,
      token: trimmedToken,
    },
  }
}

function remove(id) {
  if (id === LOCAL_ID) return false
  const state = readFile()
  const before = state.remotes.length
  state.remotes = state.remotes.filter((r) => r.id !== id)
  if (state.lastUsedId === id) state.lastUsedId = LOCAL_ID
  writeFile(state)
  return state.remotes.length !== before
}

module.exports = {
  CONFIG_PATH,
  LOCAL_ID,
  apiBaseFor,
  get,
  hasRemotes,
  isPrivateHost,
  list,
  lastUsed,
  localConnection,
  normalizeRemoteUrl,
  remove,
  save,
  setLastUsed,
}
