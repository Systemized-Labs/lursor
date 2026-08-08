/**
 * Turning the configured media source into the ref a page submits against.
 *
 * The Image and Video pages both follow whatever Settings → Image & video says —
 * neither offers its own source picker, because a second place to choose would let
 * an agent and the page generate on different models with nothing saying so. What
 * they do own is the *connection* picker, and that is the whole reason this is not
 * a one-liner: a stored source of `"laios"` means "any box", which is unambiguous
 * for resolution but not for submission, so the page has to pin it to the box the
 * header is currently showing.
 *
 * Every other source ref is already complete — `"openrouter"` names the one
 * OpenRouter, and `"custom:{id}"` names one endpoint — so it is handed through
 * untouched.
 *
 * See `app/media/refs.py` for the grammar.
 */

/** Whether this source is a LAIOS box, and therefore needs a connection. */
export function isLaiosSource(source: string | undefined): boolean {
  const value = source ?? "laios"
  return value === "laios" || value.startsWith("laios:")
}

/**
 * The ref to submit against, or `undefined` when a box is needed and none is
 * selected yet (connections still loading, or none configured).
 */
export function pageMediaSource(
  source: string | undefined,
  connectionId: string | undefined
): string | undefined {
  const value = source ?? "laios"
  if (!isLaiosSource(value)) return value
  // A ref that already names its box is what the user chose in Settings and wins
  // over the header's selection.
  if (value.startsWith("laios:")) return value
  return connectionId ? `laios:${connectionId}` : undefined
}
