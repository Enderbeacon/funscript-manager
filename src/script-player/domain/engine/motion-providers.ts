import type { InterpolationType, MotionProvider, MotionProviders, PatternType } from '../../shared/config'
import { advanceIndex, searchForIndexAfter } from './evaluate'
import { interpolateAt, type Point } from './interpolate'
import { OpenSimplex } from './noise'

/**
 * Motion providers: programs that move an axis on their own, for an axis with
 * no script or alongside one.
 *
 * Each provider keeps its own clock, advanced by `speed` times real time, and
 * maps what it produces into the configured minimum..maximum of the axis. The
 * settings are passed in on every update rather than held, so an edit in the
 * panel takes effect on the next tick without anything being rebuilt — except
 * the custom curve, which rebuilds its keyframes when its points change.
 *
 * Derived implementation; origin and licence in THIRD_PARTY_NOTICES.md.
 */

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * clamp01(t)
}

/** Map `x` from from0..to0 onto from1..to1, clamped to the ends. */
function map(x: number, from0: number, to0: number, from1: number, to1: number): number {
  return lerp(from1, to1, clamp01((x - from0) / (to0 - from0)))
}

/** Sorted by x with duplicates dropped; the first point at a given x wins. */
function keyframes(pairs: Point[]): Point[] {
  const sorted: Point[] = []
  for (const point of pairs) {
    const at = searchForIndexAfter(sorted, point.x)
    if (sorted[at]?.x === point.x) continue
    sorted.splice(at, 0, point)
  }
  return sorted
}

/**
 * The keyframes a curve of `points` across `0..width` plays through.
 *
 * A looping curve is tiled: the last points are copied in before the start and
 * the first after the end, as many as the interpolation looks at, so the seam
 * where it wraps is as smooth as the rest. A curve that does not loop holds its
 * first and last values out to the edges instead.
 */
export function curveKeyframes(
  points: readonly Point[],
  width: number,
  loop: boolean,
  interpolation: InterpolationType
): Point[] {
  if (points.length === 0) return []
  if (loop && points.length !== 1) {
    const minimumTilePointCount = interpolation === 'makima' ? 3 : interpolation === 'pchip' ? 2 : 1
    const tileCount = Math.ceil(Math.max(0, (minimumTilePointCount - points.length) / points.length)) + 1
    const takeCount = Math.min(minimumTilePointCount, points.length)
    const pairs: Point[] = []
    for (let i = tileCount; i >= 1; i--) {
      for (const point of points.slice(-takeCount)) pairs.push({ x: point.x - i * width, y: point.y })
    }
    for (const point of points) pairs.push({ x: point.x, y: point.y })
    for (let i = 1; i <= tileCount; i++) {
      for (const point of points.slice(0, takeCount)) pairs.push({ x: point.x + i * width, y: point.y })
    }
    return keyframes(pairs)
  }
  return keyframes([
    { x: 0, y: points[0]!.y },
    ...points.map((point) => ({ x: point.x, y: point.y })),
    { x: width, y: points[points.length - 1]!.y }
  ])
}

export function patternValue(pattern: PatternType, time: number): number {
  const t = clamp01((time % 4) / 4)
  switch (pattern) {
    case 'triangle': return Math.abs(Math.abs(t * 2 - 1.5) - 1)
    case 'sine': return -Math.sin(t * Math.PI * 2) / 2 + 0.5
    case 'doubleBounce': {
      const x = t * Math.PI * 2 - Math.PI / 4
      return -(Math.sin(x) ** 5 + Math.cos(x) ** 5) / 2 + 0.5
    }
    case 'sharpBounce': {
      const x = (t + 0.41957) * Math.PI / 2
      const s = Math.sin(x) * Math.sin(x)
      const c = Math.cos(x) * Math.cos(x)
      return Math.sqrt(Math.max(c - s, s - c))
    }
    case 'saw': return t
    case 'square': return t < 0.5 ? 1 : 0
  }
}

/**
 * A provider's value starts at 0 and an update that has nothing to produce
 * leaves the previous value in place. So a looping script with no file chosen
 * drives its axis to the bottom of the range; that is kept as it is, not
 * guarded, so the provider behaves the same everywhere it is used.
 */
abstract class ProviderBase {
  value = 0
}

export class RandomProvider extends ProviderBase {
  private readonly noise = new OpenSimplex()
  private time = 0

  update(deltaS: number, settings: MotionProviders['random']): void {
    const noise = this.noise.calculate2DOctaves(
      this.time, this.time, settings.octaves, settings.persistence, settings.lacunarity
    )
    this.value = map(noise, -1, 1, settings.minimum, settings.maximum)
    this.time += settings.speed * deltaS
  }
}

export class PatternProvider extends ProviderBase {
  private time = 0

  update(deltaS: number, settings: MotionProviders['pattern']): void {
    this.value = map(patternValue(settings.pattern, this.time), 0, 1, settings.minimum, settings.maximum)
    this.time += settings.speed * deltaS
  }
}

export class CustomCurveProvider extends ProviderBase {
  /** Seconds into the curve; shown as the scrubber on the curve editor. */
  time = 0
  private index = -1
  private playing = true
  private frames: Point[] | null = null
  private builtFrom: MotionProviders['customCurve'] | null = null
  private builtKey = ''
  private looping: boolean | null = null

  /** Back to the start of the curve, playing. */
  reset(): void {
    this.time = 0
    this.index = -1
    this.playing = true
  }

  /** Returns true when a curve that does not loop has just run out and wants the axis eased back in. */
  update(deltaS: number, settings: MotionProviders['customCurve']): boolean {
    if (this.looping !== null && settings.loop && !this.looping) this.playing = true
    this.looping = settings.loop

    const { points } = settings
    if (points.length === 0) return false

    const needsRefresh = this.refresh(settings)
    if (!this.frames) return false
    const frames = this.frames
    if (!this.playing) return false

    if (needsRefresh) this.index = searchForIndexAfter(frames, this.time) - 1

    if (this.time >= settings.durationS || this.index + 1 >= frames.length) {
      this.time = 0
      this.index = -1
      this.playing = settings.loop
      if (!settings.loop) {
        this.value = Number.NaN
        return settings.syncOnEnd
      }
    }

    this.index = advanceIndex(frames, this.index, this.time)
    if (this.index < 0 || this.index + 1 >= frames.length) return false

    const value = clamp01(interpolateAt(frames, this.index, this.time, settings.interpolation))
    this.value = map(value, 0, 1, settings.minimum, settings.maximum)
    this.time += settings.speed * deltaS
    return false
  }

  /**
   * Rebuild the keyframes when the shape of the curve changed: its points, its
   * length, whether it loops, or how it is interpolated — the editor draws all
   * four, and the device has to play what is drawn.
   */
  private refresh(settings: MotionProviders['customCurve']): boolean {
    if (settings === this.builtFrom) return false
    this.builtFrom = settings
    const key = JSON.stringify([settings.points, settings.durationS, settings.loop, settings.interpolation])
    if (key === this.builtKey && this.frames) return false
    this.builtKey = key
    this.frames = curveKeyframes(settings.points, settings.durationS, settings.loop, settings.interpolation)
    return true
  }
}

export class LoopingScriptProvider extends ProviderBase {
  private points: Point[] | null = null
  private time = Number.NaN
  private start = Number.NaN
  private end = Number.NaN
  private index = -1

  /** Points in seconds, or null when no script is chosen or it could not be read. */
  setScript(points: Point[] | null): void {
    this.points = points && points.length > 0 ? points : null
    this.index = -1
    this.start = this.points?.[0]!.x ?? Number.NaN
    this.end = this.points?.[this.points.length - 1]!.x ?? Number.NaN
    this.time = this.start
  }

  update(deltaS: number, settings: MotionProviders['loopingScript']): void {
    const points = this.points
    if (!points) return

    if (this.time >= this.end || this.index + 1 >= points.length) {
      this.index = -1
      this.time = this.start
    }

    this.index = advanceIndex(points, this.index, this.time)
    if (this.index < 0 || this.index + 1 >= points.length) return

    const value = clamp01(interpolateAt(points, this.index, this.time, settings.interpolation))
    this.value = map(value, 0, 1, settings.minimum, settings.maximum)
    this.time += settings.speed * deltaS
  }
}

/** One of each provider for an axis, and the last value whichever one ran produced. */
export class AxisMotionProviders {
  readonly random = new RandomProvider()
  readonly pattern = new PatternProvider()
  readonly customCurve = new CustomCurveProvider()
  readonly loopingScript = new LoopingScriptProvider()
  /** NaN until a provider has run on this axis. */
  value = Number.NaN

  /** Returns true when the provider asks for the axis to be eased back in. */
  update(provider: MotionProvider, deltaS: number, settings: MotionProviders): boolean {
    let requestSync = false
    switch (provider) {
      case 'random': this.random.update(deltaS, settings.random); break
      case 'pattern': this.pattern.update(deltaS, settings.pattern); break
      case 'customCurve': requestSync = this.customCurve.update(deltaS, settings.customCurve); break
      case 'loopingScript': this.loopingScript.update(deltaS, settings.loopingScript); break
    }
    this.value = this[provider].value
    return requestSync
  }
}
