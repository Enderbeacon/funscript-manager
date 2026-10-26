import { funscriptAxisFromToken, type FunscriptAxis } from './constants'

/**
 * Funscript parsing: pure, dependency-free (usable from renderer, main and
 * worker threads). Hand-rolled validation instead of zod — action arrays can
 * reach 100k+ entries and schema-validating each one is measurably slow.
 *
 * Normalization: actions are sorted by timestamp, positions clamped to
 * [0, 100], the `inverted` flag is applied, and duplicate timestamps keep
 * the last occurrence.
 */

export interface FunscriptAction {
  /** Timestamp in milliseconds. */
  at: number
  /** Position 0–100 (normalized: clamped, inversion applied). */
  pos: number
}

export interface ParsedFunscript {
  actions: FunscriptAction[]
  /** Timestamp of the last action, in milliseconds. */
  durationMs: number
}

/** Parse funscript JSON text. Returns null on malformed JSON or no usable actions. */
export function parseFunscript(text: string): ParsedFunscript | null {
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
  return normalizeFunscript(raw) ?? normalizeFunscriptAxes(raw).main ?? null
}

export type ParsedFunscriptAxes = Partial<Record<FunscriptAxis, ParsedFunscript>>

/** Read merged axes (1.1 axes[] or 2.0 channels{}), including the primary track. */
export function parseFunscriptAxes(text: string): ParsedFunscriptAxes {
  try {
    return normalizeFunscriptAxes(JSON.parse(text.replace(/^\uFEFF/, '')))
  } catch {
    return {}
  }
}

export function normalizeFunscriptAxes(raw: unknown): ParsedFunscriptAxes {
  if (typeof raw !== 'object' || raw === null) return {}
  const root = raw as Record<string, unknown>
  const axes: ParsedFunscriptAxes = {}
  const primary = normalizeFunscript(root)
  if (primary) axes.main = primary
  const add = (token: unknown, value: unknown): void => {
    if (typeof token !== 'string') return
    const axis = funscriptAxisFromToken(token)
    if (!axis) return
    const track = Array.isArray(value) ? { actions: value } : value
    if (!track || typeof track !== 'object') return
    const parsed = normalizeFunscript({ inverted: root.inverted, ...track })
    if (parsed) axes[axis] = parsed
  }
  if (Array.isArray(root.axes)) {
    for (const entry of root.axes) {
      if (entry && typeof entry === 'object') add(entry.id ?? entry.name, entry)
    }
  }
  if (root.channels && typeof root.channels === 'object' && !Array.isArray(root.channels)) {
    for (const [token, track] of Object.entries(root.channels)) add(token, track)
  }
  return axes
}

/** Normalize an already-parsed funscript object. */
export function normalizeFunscript(raw: unknown): ParsedFunscript | null {
  if (typeof raw !== 'object' || raw === null) return null
  const actionsRaw = (raw as { actions?: unknown }).actions
  if (!Array.isArray(actionsRaw)) return null
  const inverted = (raw as { inverted?: unknown }).inverted === true

  const actions: FunscriptAction[] = []
  for (const entry of actionsRaw) {
    if (typeof entry !== 'object' || entry === null) continue
    const at = (entry as { at?: unknown }).at
    const pos = (entry as { pos?: unknown }).pos
    if (typeof at !== 'number' || !Number.isFinite(at) || at < 0) continue
    if (typeof pos !== 'number' || !Number.isFinite(pos)) continue
    const p = Math.min(100, Math.max(0, inverted ? 100 - pos : pos))
    actions.push({ at, pos: p })
  }
  if (actions.length === 0) return null

  actions.sort((a, b) => a.at - b.at)
  const deduped: FunscriptAction[] = []
  for (const action of actions) {
    const last = deduped[deduped.length - 1]
    if (last && last.at === action.at) last.pos = action.pos
    else deduped.push(action)
  }

  return { actions: deduped, durationMs: deduped[deduped.length - 1]!.at }
}
