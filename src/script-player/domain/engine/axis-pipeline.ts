import { AXIS_CENTRE, type AxisMotion } from '../../shared/config'
import { linearThrough } from './evaluate'

/**
 * What happens to an axis between "the script says 0.42" and "send 0.42 to the
 * device".
 *
 * The order of the stages is load-bearing: the script value lands first, the
 * motion provider may replace or blend with it, auto-home may replace
 * whatever came out of that, sync eases the result in from where the axis
 * was, the smart limit reins it in by another axis, and the speed limit runs
 * last so that nothing after it can undo the limit.
 *
 * Values are 0..1 and time is milliseconds throughout, which is why the
 * "close enough to zero" guards below are written as 1. Speeds are full
 * travel per second, because that is the unit the settings are written in.
 *
 * Derived implementation; origin and licence in THIRD_PARTY_NOTICES.md.
 */

export interface AxisPipelineState {
  /** Last value handed to the outputs. NaN until the axis has moved once. */
  value: number
  /** Last script contribution, NaN when the script was not driving the axis. */
  scriptValue: number
  /** Last motion provider contribution, NaN when no provider was driving the axis. */
  motionValue: number
  /** Travel per second on the last tick, unsigned in meaning; NaN until known. */
  speed: number
  /** The value changed on the last tick. */
  dirty: boolean
  autoHomeTimeMs: number
  autoHomeStartValue: number
  autoHoming: boolean
  syncTimeMs: number
  speedLimited: boolean
  smartLimited: boolean
  /** Cursor carried between samples of this axis' script. */
  cursor: number
  /** The cursor sat on a flat stretch of the script on the last tick. */
  insideGap: boolean
}

export interface AxisPipelineInput {
  /** This tick's script contribution, already scaled and inverted; NaN when there is none. */
  scriptValue: number
  /** This tick's motion provider contribution, already blended; NaN when there is none. */
  motionValue: number
  insideScript: boolean
  playing: boolean
  deltaMs: number
  motion: AxisMotion
  syncDurationMs: number
  /** Last tick's speed of the axis the motion provider follows; NaN when it follows none. */
  followedSpeed: number
  /** Last tick's value of the smart limit's input axis; NaN when there is none. */
  smartLimitInput: number
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * clamp01(t)
}

/** The ease-in curve: barely moves at first, then closes on the script quickly. */
export function syncProgress(timeMs: number, durationMs: number): number {
  return clamp01(2 ** (-10 * clamp01(timeMs / durationMs)))
}

export function changed(a: number, b: number, epsilon: number): boolean {
  return Math.abs(a - b) > epsilon || Number.isFinite(a) !== Number.isFinite(b)
}

export function createAxisPipelineState(cursor: number): AxisPipelineState {
  return {
    value: Number.NaN,
    scriptValue: Number.NaN,
    motionValue: Number.NaN,
    speed: Number.NaN,
    dirty: false,
    autoHomeTimeMs: 0,
    autoHomeStartValue: Number.NaN,
    autoHoming: false,
    syncTimeMs: 0,
    speedLimited: false,
    smartLimited: false,
    cursor,
    insideGap: false
  }
}

/** Start easing this axis in from wherever it currently sits. */
export function resetSync(state: AxisPipelineState, durationMs: number): void {
  state.syncTimeMs = durationMs
}

/** Stroke scale around the centre, then inversion. */
export function shapeScriptValue(raw: number, motion: AxisMotion): number {
  const scaled = clamp01(AXIS_CENTRE + (raw - AXIS_CENTRE) * motion.scriptScale)
  return motion.invert ? 1 - scaled : scaled
}

/** Advance one axis. Returns the value to send, or NaN when there is nothing to send yet. */
export function stepAxis(state: AxisPipelineState, input: AxisPipelineInput): number {
  const { motion, deltaMs } = input
  const seconds = deltaMs / 1000
  const lastValue = state.value
  const lastAutoHoming = state.autoHoming

  const scriptValue = input.scriptValue
  const motionValue = input.motionValue
  const scriptDirty = changed(state.scriptValue, scriptValue, 0.000001)
  const motionDirty = changed(state.motionValue, motionValue, 0.000001)

  let value = lastValue

  // Auto-home is for an axis nothing is driving: not while the script or the
  // provider is actively moving it, and not before the axis has a position.
  const autoHomeAllowed = Number.isFinite(value)
    && motion.autoHome
    && !(!motion.autoHomeInsideScript && input.insideScript && input.playing)
    && !scriptDirty
    && !motionDirty

  if (!autoHomeAllowed) {
    state.autoHomeTimeMs = 0
    state.autoHomeStartValue = Number.NaN
    state.autoHoming = false
  }

  if (Number.isFinite(scriptValue)) value = scriptValue

  if (Number.isFinite(motionValue)) {
    value = motionValue
    // Following another axis' speed: never move faster than that axis did on
    // its last tick. The first tick has no time to measure a speed over, and
    // holds where it is.
    if (motion.matchAxisSpeed && motion.updateWithAxis !== null) {
      const maxSpeed = Math.abs(input.followedSpeed)
      const step = motionValue - lastValue
      if (Number.isFinite(maxSpeed) && Number.isFinite(step)) {
        const speed = Math.abs(step / seconds)
        if (!(speed <= maxSpeed)) {
          value = clamp01(lastValue + maxSpeed * seconds * Math.sign(step))
        }
      }
    }
  }

  if (autoHomeAllowed) {
    state.autoHomeTimeMs += deltaMs
    const delay = motion.autoHomeDelayMs
    const duration = motion.autoHomeDurationMs
    const target = motion.autoHomeTarget
    let t: number
    if (delay < 1 && duration < 1) t = 1
    else if (delay < 1) t = state.autoHomeTimeMs / duration
    else if (duration < 1) t = state.autoHomeTimeMs <= delay ? 0 : 1
    else t = (state.autoHomeTimeMs - delay) / duration

    if (t < 0) {
      state.autoHoming = false
    } else if (t === 0) {
      state.autoHoming = true
    } else if (t >= 1 && Math.abs(value - target) < 0.00001) {
      value = target
      state.autoHoming = true
    } else {
      if (!Number.isFinite(state.autoHomeStartValue)) {
        state.autoHomeStartValue = Number.isFinite(lastValue) ? lastValue : AXIS_CENTRE
      }
      t = clamp01(t)
      value = clamp01(lerp(state.autoHomeStartValue, target, t * t * (3 - 2 * t)))
      state.autoHoming = true
    }
  }

  // Coming back out of auto-home is another place the device is somewhere the
  // script did not put it, so ease in from there too.
  if (lastAutoHoming && !state.autoHoming) resetSync(state, input.syncDurationMs)

  if (state.syncTimeMs > 0) {
    const t = syncProgress(state.syncTimeMs, input.syncDurationMs)
    state.syncTimeMs = Math.max(0, state.syncTimeMs - deltaMs)
    if (!state.autoHoming && Number.isFinite(value)) {
      value = clamp01(lerp(Number.isFinite(lastValue) ? lastValue : AXIS_CENTRE, value, t))
    }
  }

  state.smartLimited = false
  if (motion.smartLimitAxis !== null && Number.isFinite(value) && motion.smartLimitPoints.length > 0) {
    const x = input.smartLimitInput * 100
    if (Number.isFinite(x)) {
      const factor = linearThrough(motion.smartLimitPoints, x) / 100
      if (motion.smartLimitMode === 'value') {
        value = clamp01(lerp(motion.smartLimitTarget, value, factor))
      } else if (Number.isFinite(lastValue)) {
        value = clamp01(lerp(lastValue, value, factor ** 4))
      }
      state.smartLimited = factor < 1
    }
  }

  state.speedLimited = false
  if (motion.speedLimit && deltaMs > 0) {
    const step = value - lastValue
    if (Number.isFinite(step)) {
      const speed = step / seconds
      if (!(Math.abs(speed) < motion.speedLimitPerSecond)) {
        value = clamp01(lastValue + motion.speedLimitPerSecond * seconds * Math.sign(speed))
        state.speedLimited = true
      }
    }
  }

  state.dirty = changed(lastValue, value, 0.000001)
  if (Number.isFinite(value) && Number.isFinite(lastValue) && deltaMs > 0) {
    state.speed = (lastValue - value) / seconds
  }
  state.scriptValue = scriptValue
  state.motionValue = motionValue
  state.value = value
  return value
}
