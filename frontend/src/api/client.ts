function resolveApiBase(): string {
  // In the desktop app the backend runs on a port chosen at launch (possibly
  // ephemeral), or on another machine entirely, so the main process hands the
  // resolved base to the renderer via the preload. This always wins when present.
  const fromElectron =
    typeof window !== "undefined" ? window.electron?.apiBase : undefined
  if (fromElectron) return fromElectron

  const configured =
    (import.meta.env.VITE_API_BASE as string | undefined) ??
    "http://localhost:8791/api"

  // When the app is opened from another device over the LAN (e.g. a phone at
  // http://192.168.x.x:8888), a hardcoded `localhost` would resolve to that
  // device instead of the machine running the API. Talk to the API on whichever
  // host served the page, port 8791. Localhost and Electron (file://) fall
  // through to the configured value unchanged.
  if (typeof window !== "undefined" && window.location.protocol.startsWith("http")) {
    const host = window.location.hostname
    if (host !== "localhost" && host !== "127.0.0.1") {
      return `${window.location.protocol}//${host}:8791/api`
    }
  }
  return configured
}

export const API_BASE: string = resolveApiBase()

/**
 * Bearer token for a backend that requires one (`LURSOR_AUTH_TOKEN` set on the
 * server — see `backend/app/auth.py`). Only the desktop app can supply it: it comes
 * from the saved connection the main process resolved at launch.
 *
 * Empty for a local backend, which is unauthenticated by design, and empty in a
 * plain browser — so a token-protected backend is not reachable from one. That is
 * a deliberate limit, not an oversight: authenticating a browser would mean a
 * login screen and a session cookie, and remote access is desktop-only.
 */
export const AUTH_TOKEN: string =
  (typeof window !== "undefined" ? window.electron?.authToken : null) ?? ""

/** Authorization header for the configured connection, or nothing at all. */
export function authHeaders(): Record<string, string> {
  return AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {}
}

/**
 * Prefix a client wraps the token in when offering it as a WebSocket subprotocol.
 * Must match `SUBPROTOCOL_PREFIX` in `backend/app/auth.py`.
 *
 * A subprotocol rather than a header because the browser WebSocket API cannot set
 * headers, and rather than a query parameter because that would put the credential
 * in every access log between here and the backend.
 */
const WS_TOKEN_PREFIX = "lursor.bearer."

export class ApiError extends Error {
  status: number
  body: unknown

  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.body = body
  }
}

// --- Unauthorized signalling ------------------------------------------------

type UnauthorizedListener = () => void
const unauthorizedListeners = new Set<UnauthorizedListener>()

/**
 * Subscribe to "the backend rejected our token".
 *
 * Worth distinguishing from any other failure because the remedy is different and
 * only the user can apply it: an unreachable backend is waited out, a rejected
 * token needs the connection editing. The shell uses this to send you back to the
 * connection picker instead of showing a wall of failed requests.
 */
export function subscribeUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener)
  return () => unauthorizedListeners.delete(listener)
}

function notifyUnauthorized() {
  for (const listener of unauthorizedListeners) listener()
}

interface RequestOptions {
  method?: string
  body?: unknown
  signal?: AbortSignal
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, signal } = options

  // FormData is sent as multipart; let the browser set the boundary header and
  // pass the body through unserialized. Everything else goes as JSON.
  const isForm = typeof FormData !== "undefined" && body instanceof FormData

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...authHeaders(),
      ...(body !== undefined && !isForm
        ? { "Content-Type": "application/json" }
        : {}),
    },
    body: body !== undefined ? (isForm ? (body as FormData) : JSON.stringify(body)) : undefined,
    signal,
  })

  if (!res.ok) {
    if (res.status === 401) notifyUnauthorized()
    let parsed: unknown = null
    try {
      parsed = await res.json()
    } catch {
      parsed = await res.text().catch(() => null)
    }
    const message =
      parsed && typeof parsed === "object" && "detail" in parsed
        ? String((parsed as { detail: unknown }).detail)
        : `Request failed with status ${res.status}`
    throw new ApiError(message, res.status, parsed)
  }

  if (res.status === 204) {
    return undefined as T
  }

  const text = await res.text()
  if (!text) {
    return undefined as T
  }
  return JSON.parse(text) as T
}

// --- WebSockets -------------------------------------------------------------

/**
 * Build a WebSocket URL for an API path, deriving scheme and host from
 * {@link API_BASE}.
 *
 * Exported for the rare caller that needs the string rather than a socket;
 * {@link connectWs} is what almost everything wants, because it also carries the
 * token.
 */
export function wsUrl(path: string, params?: Record<string, string>): string {
  const url = new URL(`${API_BASE.replace(/\/$/, "")}${path}`)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  for (const [key, value] of Object.entries(params ?? {})) {
    url.searchParams.set(key, value)
  }
  return url.toString()
}

/**
 * Open an authenticated WebSocket to an API path.
 *
 * The one place the token subprotocol is applied, and the one place the ws/wss
 * scheme is derived — four call sites used to carry their own copy of the URL
 * dance (terminal, file watch, git watch, preview feed), which is three too many
 * for something that has to agree with the server about authentication.
 */
export function connectWs(
  path: string,
  params?: Record<string, string>
): WebSocket {
  const url = wsUrl(path, params)
  return AUTH_TOKEN
    ? new WebSocket(url, [`${WS_TOKEN_PREFIX}${AUTH_TOKEN}`])
    : new WebSocket(url)
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  post: <T>(path: string, body: unknown, signal?: AbortSignal) =>
    request<T>(path, { method: "POST", body, signal }),
  upload: <T>(path: string, form: FormData, signal?: AbortSignal) =>
    request<T>(path, { method: "POST", body: form, signal }),
  put: <T>(path: string, body: unknown, signal?: AbortSignal) =>
    request<T>(path, { method: "PUT", body, signal }),
  patch: <T>(path: string, body: unknown, signal?: AbortSignal) =>
    request<T>(path, { method: "PATCH", body, signal }),
  delete: <T>(path: string, signal?: AbortSignal) =>
    request<T>(path, { method: "DELETE", signal }),
}
