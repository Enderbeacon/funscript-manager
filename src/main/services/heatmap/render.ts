import type { FunscriptAction } from '@shared/funscript'

/**
 * Funscript → heatmap pixel rendering (pure; runs inside the heatmap worker).
 *
 * The strip maps time to x and stroke position to y. Each column draws a
 * vertical bar spanning the position range covered in that time slice,
 * colored by the average stroke speed (position units per second) — the
 * community-conventional blue→green→yellow→red→purple speed gradient.
 * Columns with no actions stay fully transparent.
 */

/** Gradient stops: [speed in pos-units/second, r, g, b]. */
const SPEED_STOPS: [number, number, number, number][] = [
  [0, 30, 64, 175], // deep blue (slow)
  [100, 34, 197, 94], // green
  [200, 234, 179, 8], // yellow
  [300, 249, 115, 22], // orange
  [400, 239, 68, 68], // red
  [520, 168, 85, 247] // purple (extreme)
]

const BAR_ALPHA = 235
const MIN_BAR_PX = 2

function speedColor(speed: number): [number, number, number] {
  const last = SPEED_STOPS[SPEED_STOPS.length - 1]!
  if (speed >= last[0]) return [last[1], last[2], last[3]]
  for (let i = 1; i < SPEED_STOPS.length; i++) {
    const [v1, r1, g1, b1] = SPEED_STOPS[i]!
    if (speed > v1) continue
    const [v0, r0, g0, b0] = SPEED_STOPS[i - 1]!
    const t = v1 === v0 ? 0 : (speed - v0) / (v1 - v0)
    return [
      Math.round(r0 + (r1 - r0) * t),
      Math.round(g0 + (g1 - g0) * t),
      Math.round(b0 + (b1 - b0) * t)
    ]
  }
  return [SPEED_STOPS[0]![1], SPEED_STOPS[0]![2], SPEED_STOPS[0]![3]]
}

/**
 * Render actions to an RGBA buffer (width*height*4, row-major, transparent
 * background). Returns null when there is nothing meaningful to draw
 * (fewer than two actions or zero time span).
 */
export function renderHeatmapRgba(
  actions: FunscriptAction[],
  width: number,
  height: number
): Uint8Array | null {
  if (actions.length < 2) return null
  const t0 = actions[0]!.at
  const span = actions[actions.length - 1]!.at - t0
  if (span <= 0) return null

  // Per-column aggregation: duration-weighted speed + covered position range.
  const speedSum = new Float64Array(width)
  const weightSum = new Float64Array(width)
  const posMin = new Float64Array(width).fill(Infinity)
  const posMax = new Float64Array(width).fill(-Infinity)

  for (let i = 1; i < actions.length; i++) {
    const a = actions[i - 1]!
    const b = actions[i]!
    const dt = b.at - a.at
    if (dt <= 0) continue
    const speed = (Math.abs(b.pos - a.pos) / dt) * 1000
    const x0 = Math.min(width - 1, Math.max(0, Math.floor(((a.at - t0) / span) * width)))
    const x1 = Math.min(width - 1, Math.max(0, Math.floor(((b.at - t0) / span) * width)))
    const lo = Math.min(a.pos, b.pos)
    const hi = Math.max(a.pos, b.pos)
    const w = dt / (x1 - x0 + 1)
    for (let x = x0; x <= x1; x++) {
      speedSum[x]! += speed * w
      weightSum[x]! += w
      if (lo < posMin[x]!) posMin[x] = lo
      if (hi > posMax[x]!) posMax[x] = hi
    }
  }

  const pixels = new Uint8Array(width * height * 4)
  for (let x = 0; x < width; x++) {
    if (weightSum[x]! <= 0) continue
    const [r, g, b] = speedColor(speedSum[x]! / weightSum[x]!)
    // pos 100 at the top; guarantee a visible bar even for holds (lo == hi).
    let yTop = Math.round(((100 - posMax[x]!) / 100) * (height - 1))
    let yBot = Math.round(((100 - posMin[x]!) / 100) * (height - 1))
    if (yBot - yTop + 1 < MIN_BAR_PX) {
      yBot = Math.min(height - 1, yTop + MIN_BAR_PX - 1)
      yTop = Math.max(0, yBot - MIN_BAR_PX + 1)
    }
    for (let y = yTop; y <= yBot; y++) {
      const o = (y * width + x) * 4
      pixels[o] = r
      pixels[o + 1] = g
      pixels[o + 2] = b
      pixels[o + 3] = BAR_ALPHA
    }
  }
  return pixels
}
