import type { ModelEntry, ModelGroup } from "@/api/types"

// Cloud models are served through OpenRouter and carry this prefix. Custom
// (locally-hosted) models encode their provider as `custom:{provider_id}:{model_name}`
// so a stored string routes to the right backend. See backend `agents/builder.py`.
export const MODEL_PREFIX = "openrouter:"
export const CUSTOM_PREFIX = "custom:"

/** The string persisted / matched for a catalogue entry. */
export const entryValue = (m: ModelEntry) => m.value ?? `${MODEL_PREFIX}${m.id}`

/** True when a group holds locally-hosted (custom provider) models. */
export const isCustomGroup = (g: ModelGroup) =>
  g.models.some((m) => m.value?.startsWith(CUSTOM_PREFIX))

/**
 * Strip routing prefixes from a stored model string, returning just the bare
 * model name. Handles model names that themselves contain colons (e.g. Ollama's
 * `llama3:8b`) by only splitting off the `custom:{provider_id}:` head. Used as
 * the fallback when the catalogue can't resolve the value (provider offline, or
 * the list hasn't loaded yet) so the UI never surfaces a raw `custom:{uuid}:…`.
 */
function bareName(value: string): string {
  if (value.startsWith(CUSTOM_PREFIX)) {
    const rest = value.slice(CUSTOM_PREFIX.length)
    const sep = rest.indexOf(":")
    // `custom:{provider_id}:{model_name}` → model_name; a malformed value with
    // no model name would leave only the opaque provider id, so prefer a label.
    return sep >= 0 ? rest.slice(sep + 1) : "custom model"
  }
  if (value.startsWith(MODEL_PREFIX)) return value.slice(MODEL_PREFIX.length)
  return value
}

/** Find the catalogue entry whose persisted value matches `value`. */
function findEntry(
  value: string,
  groups: ModelGroup[] | undefined
): { group: ModelGroup; entry: ModelEntry } | null {
  if (!groups) return null
  for (const group of groups) {
    const entry = group.models.find((m) => entryValue(m) === value)
    if (entry) return { group, entry }
  }
  return null
}

/**
 * Full, human label for a stored model string: `"Provider — model"` when the
 * catalogue resolves it, else the bare model name. Use where there's room for
 * the provider context (e.g. the model picker trigger).
 */
export function formatModelLabel(
  value: string | null | undefined,
  groups?: ModelGroup[]
): string {
  if (!value) return "default model"
  const hit = findEntry(value, groups)
  if (hit) return `${hit.group.label} — ${hit.entry.label}`
  return bareName(value)
}

/**
 * Compact model name for a stored model string, for tight spots like badges.
 * Prefers the catalogue's model label, else the bare model name. Never surfaces
 * the raw `custom:{uuid}:…` routing string.
 */
export function formatModelName(
  value: string | null | undefined,
  groups?: ModelGroup[]
): string {
  if (!value) return "default model"
  const hit = findEntry(value, groups)
  if (hit) return hit.entry.label
  return bareName(value)
}
