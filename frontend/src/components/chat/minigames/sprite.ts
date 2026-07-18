// Pixel-sprite conventions shared across minigames. A sprite is a list of
// equal-length strings; "1" = filled pixel, any other char = transparent.

export type PixelSprite = string[]

/** Draw a pixel sprite as solid `px`-sized squares from the given origin. */
export function drawSprite(
  ctx: CanvasRenderingContext2D,
  rows: PixelSprite,
  originX: number,
  originY: number,
  px: number,
) {
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]
    for (let c = 0; c < row.length; c++) {
      if (row[c] === "1") {
        ctx.fillRect(originX + c * px, originY + r * px, px, px)
      }
    }
  }
}
