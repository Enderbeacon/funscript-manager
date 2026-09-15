import type { ParsedFunscript } from '@shared/funscript'
import type { AxisMotion, ScriptPlayerAxis, ScriptPlayerSettings } from '../../shared/config'
import { AXIS_CENTRE, DEFAULT_AXIS_MOTION, SCRIPT_PLAYER_AXES } from '../../shared/config'
import type { Point } from './interpolate'
import { CURSOR_AFTER, CURSOR_INVALID, gapDuration, isGap, sampleScript } from './evaluate'
import {
  createAxisPipelineState,
  resetSync,
  shapeScriptValue,
  stepAxis,
  type AxisPipelineState
} from './axis-pipeline'
import { AxisMotionProviders } from './motion-providers'

export type LoadedScripts = Partial<Record<ScriptPlayerAxis, ParsedFunscript>>

/** A discrete target for outputs that send "go here, take this long" instead of a stream. */
export interface AxisTargetEvent {
  value: number
  durationMs: number
}

export interface AxisUpdate {
  /** Value to send, NaN while the axis has nothing to say. */
  value: number
  autoHoming: boolean
  syncing: boolean
  /** The value moved this tick. */
  dirty: boolean
  /** Present only on the tick the target changes; polled outputs send these. */
  event: AxisTargetEvent | null
}

/** What each axis is doing beyond following its script, for the panel's indicators. */
export interface AxisActivity {
  speedLimited: boolean
  smartLimited: boolean
  /** Seconds into the custom curve, when that provider is selected. */
  curveTime: number | null
}

export interface EngineInput {
  /** Script time, or null when no media matches the loaded scripts. */
  positionMs: number | null
  playing: boolean
  deltaMs: number
  settings: ScriptPlayerSettings
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function toPoints(script: ParsedFunscript): Point[] {
  return script.actions.map((action) => ({ x: action.at, y: action.pos / 100 }))
}

/**
 * Owns the loaded scripts and everything that happens on the script side of the
 * player: sampling, interpolation, motion providers, auto-home, sync and the
 * limits. Output ranges are applied downstream, per output.
 *
 * Axis state outlives a script swap on purpose. Loading the next video must not
 * forget where the device is standing, or the ease-in has nothing to ease from.
 *
 * Derived implementation; origin and licence in THIRD_PARTY_NOTICES.md.
 */
export class ScriptEngine {
  private points = new Map<ScriptPlayerAxis, Point[]>()
  private readonly states = new Map<ScriptPlayerAxis, AxisPipelineState>(
    SCRIPT_PLAYER_AXES.map((axis) => [axis, createAxisPipelineState(CURSOR_INVALID)])
  )
  private readonly providers = new Map<ScriptPlayerAxis, AxisMotionProviders>(
    SCRIPT_PLAYER_AXES.map((axis) => [axis, new AxisMotionProviders()])
  )
  private lastSettings: ScriptPlayerSettings | null = null

  /** Replace every axis' script at once. */
  load(scripts: LoadedScripts): void {
    for (const axis of SCRIPT_PLAYER_AXES) this.setScript(axis, scripts[axis] ?? null)
  }

  /** Replace one axis' script; null leaves the axis without one. */
  setScript(axis: ScriptPlayerAxis, script: ParsedFunscript | null): void {
    if (script && script.actions.length > 0) this.points.set(axis, toPoints(script))
    else this.points.delete(axis)
    const state = this.states.get(axis)!
    state.cursor = CURSOR_INVALID
    state.scriptValue = Number.NaN
  }

  /**
   * Drop the scripts but not where the axes are. Forgetting the positions would
   * hand every axis straight back to the output's centre fallback, so closing a
   * video would snap the device instead of letting auto-home walk it home.
   */
  clear(): void {
    for (const axis of SCRIPT_PLAYER_AXES) this.setScript(axis, null)
  }

  /** The script a looping-script provider plays, in seconds. */
  setLoopingScript(axis: ScriptPlayerAxis, script: ParsedFunscript | null): void {
    this.providers.get(axis)!.loopingScript.setScript(
      script ? script.actions.map((action) => ({ x: action.at / 1000, y: action.pos / 100 })) : null
    )
  }

  /** Start the custom curve on this axis over from the beginning. */
  resetCurve(axis: ScriptPlayerAxis): void {
    this.providers.get(axis)!.customCurve.reset()
  }

  /** Axes with a script loaded. */
  axes(): ScriptPlayerAxis[] {
    return SCRIPT_PLAYER_AXES.filter((axis) => this.points.has(axis))
  }

  /** Last values produced, for callers that need the current position without ticking. */
  values(): Partial<Record<ScriptPlayerAxis, number>> {
    const values: Partial<Record<ScriptPlayerAxis, number>> = {}
    for (const [axis, state] of this.states) {
      if (Number.isFinite(state.value)) values[axis] = state.value
    }
    return values
  }

  activity(): Record<ScriptPlayerAxis, AxisActivity> {
    const settings = this.lastSettings
    return Object.fromEntries(SCRIPT_PLAYER_AXES.map((axis) => {
      const state = this.states.get(axis)!
      const curve = settings?.axes[axis]?.motionProvider === 'customCurve'
      return [axis, {
        speedLimited: state.speedLimited,
        smartLimited: state.smartLimited,
        curveTime: curve ? this.providers.get(axis)!.customCurve.time : null
      }]
    })) as Record<ScriptPlayerAxis, AxisActivity>
  }

  /** Ease the given axes, or every axis, in from where they currently sit. */
  resetSync(durationMs: number, axes: readonly ScriptPlayerAxis[] = SCRIPT_PLAYER_AXES): void {
    if (durationMs <= 0) return
    for (const axis of axes) resetSync(this.states.get(axis)!, durationMs)
  }

  /** Drop cursors so the next update re-locates itself; used after a seek. */
  invalidateCursors(): void {
    for (const state of this.states.values()) state.cursor = CURSOR_INVALID
  }

  update(input: EngineInput): Partial<Record<ScriptPlayerAxis, AxisUpdate>> {
    this.lastSettings = input.settings
    const deltaS = input.deltaMs / 1000
    const syncDurationMs = input.settings.syncDurationMs

    // Axes read each other — a provider following another axis' movement, a
    // smart limit keyed off another axis' position — and they read the last
    // tick, so the order the axes are stepped in cannot matter.
    const previous = new Map(SCRIPT_PLAYER_AXES.map((axis) => {
      const state = this.states.get(axis)!
      return [axis, { value: state.value, speed: state.speed, dirty: state.dirty, autoHoming: state.autoHoming }]
    }))

    const updates: Partial<Record<ScriptPlayerAxis, AxisUpdate>> = {}
    for (const axis of SCRIPT_PLAYER_AXES) {
      const state = this.states.get(axis)!
      const motion = input.settings.axes[axis] ?? DEFAULT_AXIS_MOTION[axis]
      const points = this.points.get(axis)
      const previousCursor = state.cursor
      const lastInsideGap = state.insideGap

      let scriptValue = Number.NaN
      let insideGap = false
      if (!motion.bypassScript && points && input.positionMs !== null) {
        const sample = sampleScript(points, state.cursor, input.positionMs + motion.offsetMs, motion.interpolation)
        state.cursor = sample.index
        if (sample.value !== null) {
          insideGap = isGap(points, state.cursor)
          scriptValue = shapeScriptValue(sample.value, motion)
        }
      }
      // Bypassing the script leaves its cursor where it was, and with it
      // whether the axis counts as inside the script.
      const insideScript = state.cursor >= 0 && state.cursor !== CURSOR_AFTER

      let motionValue = Number.NaN
      const provider = motion.motionProvider
      if (provider !== null && !motion.bypassMotion) {
        const providers = this.providers.get(axis)!
        let fillingGap = false
        if (motion.fillGaps && points) {
          if (insideGap && gapDuration(points, state.cursor) >= motion.minGapMs) {
            if (!lastInsideGap) resetSync(state, syncDurationMs)
            fillingGap = true
          } else if (lastInsideGap && gapDuration(points, previousCursor) >= motion.minGapMs) {
            resetSync(state, syncDurationMs)
          }
        }

        const followed = motion.updateWithAxis === null ? null : previous.get(motion.updateWithAxis)!
        const shouldUpdate = (motion.updateWhenPaused || input.playing)
          && (fillingGap || motion.updateWithoutScript || insideScript)
          && (followed === null || (followed.dirty && !followed.autoHoming))
        if (shouldUpdate && providers.update(provider, deltaS, motion.providers)) {
          resetSync(state, syncDurationMs)
        }

        const blend = insideScript && !fillingGap ? clamp01(motion.motionBlend) : 1
        const from = Number.isFinite(scriptValue) ? scriptValue : AXIS_CENTRE
        const blended = clamp01(from + (providers.value - from) * blend)
        if (Number.isFinite(blended)) motionValue = blended
      }
      state.insideGap = insideGap

      const wasAutoHoming = state.autoHoming
      const value = stepAxis(state, {
        scriptValue,
        motionValue,
        insideScript,
        playing: input.playing,
        deltaMs: input.deltaMs,
        motion,
        syncDurationMs,
        followedSpeed: motion.updateWithAxis === null
          ? Number.NaN
          : previous.get(motion.updateWithAxis)!.speed,
        smartLimitInput: motion.smartLimitAxis === null
          ? Number.NaN
          : previous.get(motion.smartLimitAxis)!.value
      })

      // An axis with nothing driving it and no position yet has nothing to say.
      if (!points && !Number.isFinite(value)) continue

      updates[axis] = {
        value,
        autoHoming: state.autoHoming,
        syncing: state.syncTimeMs > 0,
        dirty: state.dirty,
        event: this.targetEvent(motion.bypassScript ? undefined : points, state, motion, {
          cursorMoved: state.cursor !== previousCursor && previousCursor !== CURSOR_INVALID,
          startedAutoHoming: !wasAutoHoming && state.autoHoming
        })
      }
    }
    return updates
  }

  /**
   * One of these fires when auto-home starts, or when the cursor steps to a new
   * pair of actions. The target is the next action rather than the value at
   * this instant, because an output in polled mode is being told where to go
   * and how long to take, not streamed a position.
   *
   * Stroke scale, inversion and the speed limit are applied to the target here
   * as well. Motion providers and the smart limit are not: they are shaped tick
   * by tick and have no "next action" to announce.
   */
  private targetEvent(
    points: Point[] | undefined,
    state: AxisPipelineState,
    motion: AxisMotion,
    fired: { cursorMoved: boolean; startedAutoHoming: boolean }
  ): AxisTargetEvent | null {
    if (fired.startedAutoHoming) {
      return { value: motion.autoHomeTarget, durationMs: motion.autoHomeDurationMs }
    }
    if (!fired.cursorMoved || !points) return null

    const from = points[state.cursor]
    const to = points[state.cursor + 1]
    if (!from || !to) return null

    const start = shapeScriptValue(from.y, motion)
    let target = shapeScriptValue(to.y, motion)
    const durationMs = to.x - from.x

    if (motion.speedLimit && durationMs > 0) {
      const seconds = durationMs / 1000
      const speed = (target - start) / seconds
      if (Math.abs(speed) >= motion.speedLimitPerSecond) {
        target = clamp01(start + motion.speedLimitPerSecond * seconds * Math.sign(speed))
      }
    }

    return { value: target, durationMs }
  }
}
