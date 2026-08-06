import type { MediaPrice } from "@/api/types"

/**
 * A media price as one short phrase, or `""` when nothing is known.
 *
 * Empty rather than `"$0.00"`, everywhere. The two sources report cost very
 * differently — a LAIOS box reports none at all, an OpenRouter video model
 * publishes a per-second rate, and an OpenRouter *image* model publishes nothing
 * until this install has actually paid for one (see `app/media/history.py`) — so
 * "unknown" is a common and honest state. Rendering it as free would be a claim
 * about money that nobody made.
 *
 * `approximate` becomes "from", because a video rate is the cheapest of several
 * (480p vs 1080p, audio on or off) and an image price is a mean of past runs.
 */
export function priceLabel(price: MediaPrice | null): string {
  if (!price) return ""
  const unit = price.unit === "second" ? "a second" : "an image"
  const amount =
    price.amount < 0.1 ? price.amount.toFixed(3) : price.amount.toFixed(2)
  return `${price.approximate ? "from " : ""}$${amount} ${unit}`
}
