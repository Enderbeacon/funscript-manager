import type { AxisRange, ScriptPlayerAxis } from '../../shared/config'

export interface AxisValue {
  axis: ScriptPlayerAxis
  /** Script-space value, normalized to 0..1. */
  source: number
  /** Value after output-range mapping, normalized to 0..1. */
  output: number
}

export function applyAxisRange(value: number, range: AxisRange): number {
  const normalized = Math.min(1, Math.max(0, value))
  return range.min + normalized * (range.max - range.min)
}
