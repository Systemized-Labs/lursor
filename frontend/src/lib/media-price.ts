import type { MediaPrice } from "@/api/types"

/** What each rate is charged per, as it reads in a sentence. */
const UNITS: Record<string, string> = {
  second: "a second",
  image: "an image",
  megapixel: "a megapixel",
}

/**
 * A media price as one short phrase, or `""` when nothing is known.
 *
 * Empty rather than `"$0.00"`, everywhere. The sources report cost differently —
 * a LAIOS box reports none at all, and an OpenRouter model billed per output
 * token publishes no rate a picker can state until this install has actually paid
 * for an image (see `app/media/history.py`) — so "unknown" is a real and honest
 * state. Rendering it as free would be a claim about money that nobody made.
 *
 * `approximate` becomes "from", because a rate quoted several times over is the
 * cheapest of alternatives (480p vs 1080p, 1K vs 2K, one provider vs another) and
 * an observed image price is a mean of past runs.
 */
export function priceLabel(price: MediaPrice | null): string {
  if (!price) return ""
  const unit = UNITS[price.unit] ?? `a ${price.unit}`
  const amount =
    price.amount < 0.1 ? price.amount.toFixed(3) : price.amount.toFixed(2)
  return `${price.approximate ? "from " : ""}$${amount} ${unit}`
}
