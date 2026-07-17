export const API_BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) ??
  "http://localhost:8791/api"

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
    headers:
      body !== undefined && !isForm
        ? { "Content-Type": "application/json" }
        : undefined,
    body: body !== undefined ? (isForm ? (body as FormData) : JSON.stringify(body)) : undefined,
    signal,
  })

  if (!res.ok) {
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
