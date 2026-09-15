import type { InterpolationType } from '../../shared/config'
import { interpolateAt, type Point } from './interpolate'

/**
 * Script sampling with a per-axis cursor.
 *
 * The cursor is the index of the action at or before the current time, so
 * ordinary playback advances it one step at a time and only a seek pays for a
 * binary search. Outside the script the sample is `null` rather than the first
 * or last position: an axis with nothing driving it is handed to auto-home,
 * which is what decides where it should rest.
 *
 * Derived implementation; origin and licence in THIRD_PARTY_NOTICES.md.
 */

export const CURSOR_INVALID = Number.MIN_SAFE_INTEGER
export const CURSOR_BEFORE = -1
export const CURSOR_AFTER = Number.MAX_SAFE_INTEGER

export interface ScriptSample {
  /** Cursor to carry into the next sample of this axis. */
  index: number
  /** Normalized 0..1 script position, or null when nothing drives the axis. */
  value: number | null
  insideScript: boolean
}

/** Index of the first point at or after `atMs`; `points.length` when past the end. */
export function searchForIndexAfter(points: readonly Point[], atMs: number): number {
  if (points.length === 0 || atMs < points[0]!.x) return 0
  if (atMs > points[points.length - 1]!.x) return points.length
  let low = 0
  let high = points.length - 1
  while (low < high) {
    const middle = (low + high) >> 1
    if (points[middle]!.x < atMs) low = middle + 1
    else high = middle
  }
  return low
}

export function advanceIndex(points: readonly Point[], index: number, atMs: number): number {
  while (index + 1 >= 0 && index + 1 < points.length && points[index + 1]!.x <= atMs) index++
  return index
}

export function sampleScript(
  points: readonly Point[],
  cursor: number,
  atMs: number,
  type: InterpolationType
): ScriptSample {
  if (points.length === 0) return { index: CURSOR_INVALID, value: null, insideScript: false }

  let index = cursor
  const afterScript = index === CURSOR_AFTER
  const rewound = index >= 0 && index < points.length && points[index]!.x > atMs
  if (index === CURSOR_INVALID || rewound || (afterScript && points[points.length - 1]!.x > atMs)) {
    index = searchForIndexAfter(points, atMs) - 1
  } else if (afterScript) {
    return { index, value: null, insideScript: false }
  }

  index = advanceIndex(points, index, atMs)

  if (index + 1 >= points.length) {
    return { index: CURSOR_AFTER, value: null, insideScript: false }
  }
  if (index < 0) {
    return { index: CURSOR_BEFORE, value: null, insideScript: false }
  }

  const value = Math.min(1, Math.max(0, interpolateAt(points, index, atMs, type)))
  return { index, value, insideScript: true }
}

/** A segment the script does not move through: flat, or with both ends at the same instant. */
function isGapAt(points: readonly Point[], index: number): boolean {
  const prev = points[index]!
  const next = points[index + 1]!
  return Math.abs(next.y - prev.y) < 0.001 || Math.abs(next.x - prev.x) < 1
}

export function isGap(points: readonly Point[], index: number): boolean {
  if (index < 0 || index + 1 >= points.length) return false
  return isGapAt(points, index)
}

/**
 * How long the script stays still from `index` on, across consecutive flat
 * segments. -1 when `index` does not start one.
 */
export function gapDuration(points: readonly Point[], index: number): number {
  if (index < 0 || index + 1 >= points.length) return -1
  let after = index
  while (after + 1 < points.length && isGapAt(points, after)) after++
  if (after === index) return -1
  return points[after]!.x - points[index]!.x
}

/**
 * Piecewise-linear lookup through a curve of points sorted by `x`, holding the
 * first and last `y` beyond the ends.
 */
export function linearThrough(points: readonly Point[], x: number): number {
  if (x < points[0]!.x) return points[0]!.y
  for (let i = 0, j = 1; j < points.length; i = j++) {
    const x0 = points[i]!.x
    const x1 = points[j]!.x
    if (x >= x0 && x < x1) {
      const t = Math.min(1, Math.max(0, (x - x0) / (x1 - x0)))
      return points[i]!.y + (points[j]!.y - points[i]!.y) * t
    }
  }
  return points[points.length - 1]!.y
}
