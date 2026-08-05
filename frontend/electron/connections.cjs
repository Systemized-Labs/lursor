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

/**
 * Validate and normalize a remote backend address to its origin.
 *
 * Accepts what a user is likely to paste — a bare host, a full origin, or the API
 * base with `/api` already on it — and returns just the origin, because that is
 * what {@link apiBaseFor} builds from.
 *
 * @returns {{ url: string } | { error: string }}
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

  const isLoopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname === "[::1]"

  // The token authenticates every request, so sending it over plain HTTP to
  // anything but this machine hands a shell to whoever is on the path. Refused
  // here rather than warned about, because there is no version of this that is a
  // good idea. Loopback stays allowed — it is how remote mode is tested without a
  // VPS, and nothing leaves the machine.
  if (url.protocol === "http:" && !isLoopback) {
    return {
      error:
        "Plain http:// would send the token in the clear. Use https:// (put the " +
        "backend behind a TLS reverse proxy — see docs/REMOTE.md).",
    }
  }

  return { url: url.origin }
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
  list,
  lastUsed,
  localConnection,
  normalizeRemoteUrl,
  remove,
  save,
  setLastUsed,
}
