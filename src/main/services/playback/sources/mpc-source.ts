import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { AppError } from '@shared/errors'
import { BaseMediaSource, looksFinished } from './base'
import { MediaClock } from './clock'
import {
  EMPTY_READING,
  type ConnectOptions,
  type MediaSourceAdapter,
  type MediaSourceCapabilities,
  type MediaSourceReading
} from './port'

/**
 * MPC-HC through its web interface.
 *
 * The player has no push channel: state is read by polling `variables.html`,
 * which returns a page of `<p id="name">value</p>` lines. Everything else —
 * opening a file, seeking, pausing — is a GET on the same server.
 *
 * The web interface is off in a stock MPC-HC. We do not switch it on for the
 * user: it is their copy of somebody else's program. Failing to connect says
 * where the switch is instead.
 */

/**
 * MPC-HC's own command ids. The negative ones take an argument of their own:
 * `-1` a `position`, `-2` a `volume` (0–100).
 */
const CMD_SEEK = -1
const CMD_SET_VOLUME = -2
const CMD_PLAY = 887
const CMD_PAUSE = 888

/** Five reads a second is what it takes to keep a device in step. */
const POLL_MS = 200
/** Two dead polls in a row is a dropped connection, not a slow answer. */
const FAILURES_BEFORE_DROP = 2

const VARIABLE = /<p id="(.+?)">(.*?)<\/p>/g

function parseVariables(html: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const match of html.matchAll(VARIABLE)) out.set(match[1]!, match[2]!)
  return out
}

/** MPC-HC wants `hh:mm:ss`; sub-second precision is not part of the interface. */
function hhmmss(positionMs: number): string {
  const total = Math.max(0, Math.floor(positionMs / 1000))
  const h = String(Math.floor(total / 3600)).padStart(2, '0')
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
  const s = String(total % 60).padStart(2, '0')
  return `${h}:${m}:${s}`
}

export class MpcSource extends BaseMediaSource implements MediaSourceAdapter {
  readonly kind = 'mpc-hc' as const
  readonly capabilities: MediaSourceCapabilities = {
    open: true,
    seek: true,
    pause: true,
    volume: true,
    launch: true
  }

  private readonly clock = new MediaClock()
  private timer: NodeJS.Timeout | null = null
  private polling = false
  private failures = 0
  private connected = false
  private lastPath: string | null = null
  private lastState: number | null = null
  private endedFor: string | null = null

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly exePath: string
  ) {
    super()
  }

  private get base(): string {
    return `http://${this.host}:${this.port}`
  }

  async connect({ launch }: ConnectOptions): Promise<void> {
    if (this.connected) return
    if (!(await this.reachable(2000))) {
      if (!launch || !this.exePath || !existsSync(this.exePath)) {
        throw new AppError('player_unreachable')
      }
      await this.launchPlayer()
    }
    this.connected = true
    this.failures = 0
    this.timer = setInterval(() => void this.poll(), POLL_MS)
    this.timer.unref()
    await this.poll()
  }

  private async reachable(timeoutMs: number): Promise<boolean> {
    try {
      const res = await fetch(`${this.base}/variables.html`, {
        signal: AbortSignal.timeout(timeoutMs)
      })
      return res.ok
    } catch {
      return false
    }
  }

  /** Start the user's MPC-HC and wait for its web interface to answer. */
  private async launchPlayer(): Promise<void> {
    try {
      const proc = spawn(this.exePath, [], { detached: true, stdio: 'ignore' })
      proc.unref()
    } catch {
      throw new AppError('player_unreachable')
    }
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      if (await this.reachable(500)) return
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new AppError('player_unreachable')
  }

  private async poll(): Promise<void> {
    if (!this.connected || this.polling) return
    this.polling = true
    try {
      const res = await fetch(`${this.base}/variables.html`, {
        signal: AbortSignal.timeout(1500)
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      this.apply(parseVariables(await res.text()))
      this.failures = 0
    } catch {
      if (++this.failures >= FAILURES_BEFORE_DROP) this.drop()
    } finally {
      this.polling = false
    }
  }

  private apply(vars: Map<string, string>): void {
    const state = Number(vars.get('state') ?? '-1')
    const path = vars.get('filepath')?.trim() || null
    // A negative state means no file is loaded at all, whatever `filepath` says.
    if (state < 0 || path === null) {
      this.lastState = state
      this.notePath(null)
      return
    }
    this.notePath(path)

    const duration = Number(vars.get('duration') ?? '')
    if (Number.isFinite(duration)) this.clock.setDuration(duration)
    const speed = Number(vars.get('playbackrate')?.replace(',', '.') ?? '')
    if (Number.isFinite(speed) && speed > 0) this.clock.setSpeed(speed)
    this.clock.setPaused(state !== 2)
    const position = Number(vars.get('position') ?? '')
    if (Number.isFinite(position)) this.clock.setPosition(position)
    // Muted is its own flag in the player, but the app has one volume control:
    // muted reads as zero, which is what the slider would show anyway.
    const volume = Number(vars.get('volumelevel') ?? '')
    const muted = vars.get('muted') === '1'
    this.clock.setVolume(Number.isFinite(volume) ? (muted ? 0 : volume) : null)

    // Stopping at the end is how this player reports a file running out; it
    // also stops when the user presses stop, so the position has to agree.
    const stopped = state === 0 && this.lastState === 2
    if (
      this.endedFor !== path &&
      (stopped || state === 1) &&
      looksFinished(this.clock.positionMs(), this.clock.durationMs())
    ) {
      this.endedFor = path
      this.emit('ended')
    }
    this.lastState = state
  }

  private notePath(path: string | null): void {
    if (path === this.lastPath) return
    this.lastPath = path
    this.endedFor = null
    this.clock.setPath(path)
    if (path === null) this.clock.reset()
    else this.clock.invalidatePosition()
    this.emit('path-changed', { path })
  }

  private drop(): void {
    if (!this.connected) return
    this.stopPolling()
    this.connected = false
    this.clock.reset()
    this.lastPath = null
    this.emit('closed')
  }

  private stopPolling(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async disconnect(): Promise<void> {
    this.stopPolling()
    this.connected = false
    this.clock.reset()
    this.lastPath = null
  }

  read(): MediaSourceReading {
    if (!this.connected) return EMPTY_READING
    return {
      path: this.clock.path(),
      positionMs: this.clock.positionMs(),
      durationMs: this.clock.durationMs(),
      paused: this.clock.paused,
      volume: this.clock.volumePercent()
    }
  }

  private async send(query: string): Promise<void> {
    if (!this.connected) throw new AppError('player_unreachable')
    const res = await fetch(`${this.base}/${query}`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) throw new AppError('player_unreachable')
  }

  async open(path: string, startAtMs: number | null): Promise<void> {
    await this.send(`browser.html?path=${encodeURIComponent(path)}`)
    if (startAtMs === null) return
    // The file has to be loaded before it can be seeked into, and loading is
    // not part of the reply. Wait for the player to admit it changed files.
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150))
      await this.poll()
      if (this.clock.path() === path) break
    }
    await this.seek(startAtMs)
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.send(`command.html?wm_command=${paused ? CMD_PAUSE : CMD_PLAY}`)
  }

  async seek(positionMs: number): Promise<void> {
    await this.send(`command.html?wm_command=${CMD_SEEK}&position=${hhmmss(positionMs)}`)
    this.clock.setPosition(positionMs)
  }

  async setVolume(volume: number): Promise<void> {
    const level = Math.min(100, Math.max(0, Math.round(volume)))
    await this.send(`command.html?wm_command=${CMD_SET_VOLUME}&volume=${level}`)
    // The next poll confirms it; showing it now keeps the slider under the
    // pointer instead of snapping back for a fifth of a second.
    this.clock.setVolume(level)
  }
}
