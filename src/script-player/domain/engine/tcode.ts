import type { ScriptPlayerAxis } from '../../shared/config'
import { TCODE_CHANNEL_BY_AXIS } from '../../shared/config'

/** Encode one atomic TCode line using the selected device precision. */
export function encodeTCode(
  values: Partial<Record<ScriptPlayerAxis, number>>,
  intervalMs: number | null,
  precision: 3 | 4 = 4
): string {
  const commands: string[] = []
  const scale = 10 ** precision
  const ceiling = scale - 1
  for (const [axis, value] of Object.entries(values) as [ScriptPlayerAxis, number][]) {
    if (!Number.isFinite(value)) continue
    const magnitude = Math.min(ceiling, Math.max(0, Math.round(value * ceiling)))
    const command = `${TCODE_CHANNEL_BY_AXIS[axis]}${String(magnitude).padStart(precision, '0')}`
    // floor(ms + 0.75) rather than a plain round: an interval under a
    // millisecond must not reach the device as I0, which tells it to move as
    // fast as it can.
    commands.push(intervalMs === null ? command : `${command}I${Math.max(0, Math.floor(intervalMs + 0.75))}`)
  }
  return commands.length > 0 ? `${commands.join(' ')}\n` : ''
}

/**
 * Encode discrete per-axis targets. Each axis carries its own duration, so a
 * roll that takes 400ms and a stroke that takes 90ms still commit on one line.
 */
export function encodeTCodeTargets(
  targets: Partial<Record<ScriptPlayerAxis, { value: number; durationMs: number }>>,
  omitInterval: boolean,
  precision: 3 | 4 = 4
): string {
  const commands: string[] = []
  const ceiling = 10 ** precision - 1
  for (const [axis, target] of Object.entries(targets) as [ScriptPlayerAxis, { value: number; durationMs: number }][]) {
    if (!Number.isFinite(target.value)) continue
    const magnitude = Math.min(ceiling, Math.max(0, Math.round(target.value * ceiling)))
    const command = `${TCODE_CHANNEL_BY_AXIS[axis]}${String(magnitude).padStart(precision, '0')}`
    commands.push(omitInterval ? command : `${command}I${Math.max(0, Math.floor(target.durationMs + 0.75))}`)
  }
  return commands.length > 0 ? `${commands.join(' ')}\n` : ''
}

export const TCODE_STOP = 'DSTOP\n'
