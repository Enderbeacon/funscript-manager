import type { FunscriptAction } from '@shared/funscript'

/**
 * Funscript → heatmap pixel rendering (pure; runs inside the heatmap worker).
 *
 * The strip maps time to x and stroke position to y. Each column draws a
 * vertical bar spanning the position range covered in that time slice,
 * colored by the average stroke speed (position units per second) — the
 * community-conventional blue→green→yellow→red→purple speed gradient.
 * Time starts at zero and spans the media duration when known. Columns with
 * no movement stay fully transparent, including holds and unscripted time.
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
 * (fewer than two actions or an invalid canvas/time span).
 */
export function renderHeatmapRgba(
  actions: FunscriptAction[],
  width: number,
  height: number,
  durationMs?: number
): Uint8Array | null {
  if (actions.length < 2) return null
  const span = durationMs ?? actions[actions.length - 1]!.at
  if (
    !Number.isFinite(span) || span <= 0 || !Number.isInteger(width) || width <= 0 ||
    !Number.isInteger(height) || height <= 0
  ) {
    return null
  }
  const columnMs = span / width

  // Per-column aggregation: duration-weighted speed + covered position range.
  const speedSum = new Float64Array(width)
  const posMin = new Float64Array(width).fill(Infinity)
  const posMax = new Float64Array(width).fill(-Infinity)

  for (let i = 1; i < actions.length; i++) {
    const a = actions[i - 1]!
    const b = actions[i]!
    const dt = b.at - a.at
    const delta = b.pos - a.pos
    if (dt <= 0 || delta === 0) continue
    const start = Math.max(0, a.at)
    const end = Math.min(span, b.at)
    if (end <= start) continue
    const speed = (Math.abs(delta) / dt) * 1000
    // Half-open slices: a segment ending at a column boundary contributes
    // nothing to the next column. Each weight is the actual overlap in ms.
    const x0 = Math.max(0, Math.floor(start / columnMs))
    const x1 = Math.min(width - 1, Math.ceil(end / columnMs) - 1)
    for (let x = x0; x <= x1; x++) {
      const left = Math.max(start, x * columnMs)
      const right = Math.min(end, (x + 1) * columnMs)
      if (right <= left) continue
      const p0 = a.pos + delta * ((left - a.at) / dt)
      const p1 = a.pos + delta * ((right - a.at) / dt)
      const lo = Math.min(p0, p1)
      const hi = Math.max(p0, p1)
      speedSum[x]! += speed * (right - left)
      if (lo < posMin[x]!) posMin[x] = lo
      if (hi > posMax[x]!) posMax[x] = hi
    }
  }

  const pixels = new Uint8Array(width * height * 4)
  for (let x = 0; x < width; x++) {
    if (speedSum[x]! <= 0) continue
    // Average over the whole slice: holds and unscripted portions have zero
    // speed. Short bursts should not color an entire slice at peak speed.
    const [r, g, b] = speedColor(speedSum[x]! / columnMs)
    // pos 100 at the top; keep small movements visible at this resolution.
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
