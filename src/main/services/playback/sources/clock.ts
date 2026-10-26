/**
 * Playback clock shared by every player.
 *
 * No player reports its position often enough, or evenly enough, to be read
 * directly: mpv sends a frame-granular event plus pipe jitter, MPC-HC is
 * polled five times a second, HereSphere pushes when it feels like it. So the
 * clock keeps the last (position, wallclock) pair and extrapolates between
 * updates. Feeding it is all a player adapter has to do; how far the updates
 * are apart only affects how much of the answer is extrapolated.
 */

interface Sample {
  /** Reported position, milliseconds. */
  positionMs: number
  /** performance.now() when it was reported. */
  atMs: number
  speed: number
  paused: boolean
  /** Small report errors are removed gradually rather than stepping time. */
  correctionMs?: number
  correctionDurationMs?: number
}

const CORRECTION_MS = 250
const DISCONTINUITY_MS = 250

export class MediaClock {
  private sample: Sample | null = null
  private speed = 1
  private pausedFlag: boolean | null = null
  private duration: number | null = null
  private volume: number | null = null
  private file: string | null = null

  /** A fresh position straight from the player; restarts extrapolation. */
  setPosition(positionMs: number | null): void {
    if (positionMs === null || !Number.isFinite(positionMs)) {
      this.sample = null
      return
    }
    this.sample = {
      positionMs,
      atMs: performance.now(),
      speed: this.speed,
      paused: this.pausedFlag ?? false
    }
  }

  /**
   * Correct a periodic report while preserving continuous forward playback.
   * The renderer's epoch-based monotonic timestamp includes time spent in IPC.
   * Explicit seeks and large discontinuities still take effect immediately.
   */
  correctPosition(positionMs: number | null, sampledAtMs?: number, discontinuity = false): void {
    if (positionMs === null || !Number.isFinite(positionMs)) {
      this.setPosition(null)
      return
    }
    const now = performance.now()
    const paused = this.pausedFlag ?? false
    const delay = sampledAtMs !== undefined && Number.isFinite(sampledAtMs)
      ? Math.max(0, performance.timeOrigin + now - sampledAtMs)
      : 0
    const target = positionMs + (paused ? 0 : delay * this.speed)
    const current = this.positionMs()
    if (current === null || paused || discontinuity || Math.abs(target - current) > DISCONTINUITY_MS) {
      this.setPosition(target)
      return
    }
    const error = target - current
    this.sample = {
      positionMs: current,
      atMs: now,
      speed: this.speed,
      paused: false,
      correctionMs: error,
      // A backward correction can slow the clock by at most half its rate;
      // it cannot reverse motion, including at reduced playback speeds.
      correctionDurationMs: Math.max(CORRECTION_MS, Math.abs(error) / (this.speed * 0.5))
    }
  }

  setPaused(paused: boolean): void {
    if (paused === this.pausedFlag) return
    // Freeze (or unfreeze) where the extrapolation has got to, so a pause does
    // not rewind the bar to the last thing the player happened to report.
    const at = this.positionMs()
    this.pausedFlag = paused
    if (at !== null) this.sample = { positionMs: at, atMs: performance.now(), speed: this.speed, paused }
  }

  setSpeed(speed: number): void {
    if (!Number.isFinite(speed) || speed <= 0 || speed === this.speed) return
    const at = this.positionMs()
    this.speed = speed
    if (at !== null) {
      this.sample = { positionMs: at, atMs: performance.now(), speed, paused: this.pausedFlag ?? false }
    }
  }

  setDuration(durationMs: number | null): void {
    this.duration = durationMs !== null && durationMs > 0 ? durationMs : null
  }

  setVolume(volume: number | null): void {
    this.volume = volume
  }

  setPath(path: string | null): void {
    this.file = path && path.trim() ? path : null
  }

  /** A seek was seen: extrapolating from the old baseline would be a lie. */
  invalidatePosition(): void {
    this.sample = null
  }

  /** The player let go of the file (idle, stopped, disconnected). */
  reset(): void {
    this.sample = null
    this.duration = null
    this.file = null
    this.pausedFlag = null
  }

  path(): string | null {
    return this.file
  }

  positionMs(): number | null {
    if (!this.sample) return null
    if (this.sample.paused) return this.sample.positionMs
    const elapsed = Math.max(0, performance.now() - this.sample.atMs)
    const correction = (this.sample.correctionMs ?? 0) *
      Math.min(1, elapsed / (this.sample.correctionDurationMs ?? 1))
    return this.sample.positionMs + elapsed * this.sample.speed + correction
  }

  get playbackRate(): number {
    return this.speed
  }

  durationMs(): number | null {
    return this.duration
  }

  volumePercent(): number | null {
    return this.volume
  }

  get paused(): boolean | null {
    return this.pausedFlag
  }
}
