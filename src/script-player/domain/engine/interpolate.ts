/**
 * Interpolation between the actions of a script.
 *
 * The formulas are written out literally rather than tidied up. How a device
 * feels comes out of these exact slope weightings, so anything that looks like
 * a simplification here is a change to how the hardware moves.
 *
 * x is milliseconds. Every function is scale-invariant in x, so the unit only
 * has to be consistent.
 *
 * Derived implementation; origin and licence in THIRD_PARTY_NOTICES.md.
 */

import type { InterpolationType } from '../../shared/config'

export interface Point {
  x: number
  y: number
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * clamp01(t)
}

export function cubicHermite(
  x0: number, y0: number, x1: number, y1: number, s0: number, s1: number, x: number
): number {
  const d = x1 - x0
  const dx = x - x0
  const t = dx / d
  const r = 1 - t
  return r * r * (y0 * (1 + 2 * t) + s0 * dx) + t * t * (y1 * (3 - 2 * t) - d * s1 * r)
}

function pchipSlopes(
  x0: number, y0: number, x1: number, y1: number,
  x2: number, y2: number, x3: number, y3: number
): [number, number] {
  const hkm1 = x1 - x0
  const dkm1 = (y1 - y0) / hkm1
  const hk1 = x2 - x1
  const dk1 = (y2 - y1) / hk1
  const w11 = 2 * hk1 + hkm1
  const w12 = hk1 + 2 * hkm1

  let s1 = (w11 + w12) / (w11 / dkm1 + w12 / dk1)
  if (!Number.isFinite(s1) || dk1 * dkm1 < 0) s1 = 0

  const hkm2 = x2 - x1
  const dkm2 = (y2 - y1) / hkm2
  const hk2 = x3 - x2
  const dk2 = (y3 - y2) / hk2
  const w21 = 2 * hk2 + hkm2
  const w22 = hk2 + 2 * hkm2

  let s2 = (w21 + w22) / (w21 / dkm2 + w22 / dk2)
  if (!Number.isFinite(s2) || dk2 * dkm2 < 0) s2 = 0

  return [s1, s2]
}

export function pchip(
  x0: number, y0: number, x1: number, y1: number,
  x2: number, y2: number, x3: number, y3: number, x: number
): number {
  const [s1, s2] = pchipSlopes(x0, y0, x1, y1, x2, y2, x3, y3)
  return cubicHermite(x1, y1, x2, y2, s1, s2, x)
}

function makimaSlopes(
  x0: number, y0: number, x1: number, y1: number, x2: number, y2: number,
  x3: number, y3: number, x4: number, y4: number, x5: number, y5: number
): [number, number] {
  const m4 = (y5 - y4) / (x5 - x4)
  const m3 = (y4 - y3) / (x4 - x3)
  const m2 = (y3 - y2) / (x3 - x2)
  const m1 = (y2 - y1) / (x2 - x1)
  const m0 = (y1 - y0) / (x1 - x0)

  const w11 = Math.abs(m3 - m2) + Math.abs(m3 + m2) / 2
  const w12 = Math.abs(m1 - m0) + Math.abs(m1 + m0) / 2
  let s1 = (w11 * m1 + w12 * m2) / (w11 + w12)
  if (!Number.isFinite(s1)) s1 = 0

  const w21 = Math.abs(m4 - m3) + Math.abs(m4 + m3) / 2
  const w22 = Math.abs(m2 - m1) + Math.abs(m2 + m1) / 2
  let s2 = (w21 * m2 + w22 * m3) / (w21 + w22)
  if (!Number.isFinite(s2)) s2 = 0

  return [s1, s2]
}

export function makima(
  x0: number, y0: number, x1: number, y1: number, x2: number, y2: number,
  x3: number, y3: number, x4: number, y4: number, x5: number, y5: number, x: number
): number {
  const [s1, s2] = makimaSlopes(x0, y0, x1, y1, x2, y2, x3, y3, x4, y4, x5, y5)
  return cubicHermite(x2, y2, x3, y3, s1, s2, x)
}

export function linear(x0: number, y0: number, x1: number, y1: number, x: number): number {
  return lerp(y0, y1, (x - x0) / (x1 - x0))
}

/**
 * Interpolate between `points[index]` and `points[index + 1]`.
 *
 * The cubic methods need neighbours on both sides, and at the first and last
 * action of a script one of them does not exist. A missing neighbour is
 * reflected outward as `(3 * b.x - 2 * a.x, b.y)`.
 *
 * The pairings passed to `take` below — in particular makima's pm2 and pp2 —
 * are deliberate and load-bearing: they decide how the opening and closing
 * segments of every script move, and they are pinned by the interpolation
 * assertions in `scripts/script-player-protocol-check.ts`. Do not "correct"
 * them without changing those expected values on purpose.
 */
export function interpolateAt(
  points: readonly Point[],
  index: number,
  x: number,
  type: InterpolationType
): number {
  const take = (at: number, a: Point, b: Point): Point =>
    points[at] ?? { x: 3 * b.x - 2 * a.x, y: b.y }

  const p0 = points[index]!
  const p1 = points[index + 1]!

  switch (type) {
    case 'linear':
      return linear(p0.x, p0.y, p1.x, p1.y, x)
    case 'step':
      return p0.y
    case 'pchip': {
      const pm1 = take(index - 1, p1, p0)
      const pp1 = take(index + 2, p0, p1)
      return pchip(pm1.x, pm1.y, p0.x, p0.y, p1.x, p1.y, pp1.x, pp1.y, x)
    }
    case 'makima': {
      const pm1 = take(index - 1, p1, p0)
      const pm2 = take(index - 2, pm1, p1)
      const pp1 = take(index + 2, p0, p1)
      const pp2 = take(index + 3, p1, pp1)
      return makima(
        pm2.x, pm2.y, pm1.x, pm1.y, p0.x, p0.y,
        p1.x, p1.y, pp1.x, pp1.y, pp2.x, pp2.y, x
      )
    }
  }
}
