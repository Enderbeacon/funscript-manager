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
}

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

  setPaused(paused: boolean): void {
    // Freeze (or unfreeze) where the extrapolation has got to, so a pause does
    // not rewind the bar to the last thing the player happened to report.
    const at = this.positionMs()
    this.pausedFlag = paused
    if (at !== null) this.sample = { positionMs: at, atMs: performance.now(), speed: this.speed, paused }
  }

  setSpeed(speed: number): void {
    if (!Number.isFinite(speed) || speed <= 0) return
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
    return this.sample.positionMs + (performance.now() - this.sample.atMs) * this.sample.speed
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
