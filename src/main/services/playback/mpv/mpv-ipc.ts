import { EventEmitter } from 'node:events'
import { createConnection, type Socket } from 'node:net'
import { MPV_PIPE_NAME } from '@shared/constants'

/**
 * mpv JSON IPC client.
 *
 * - Named pipe defaults to \\.\pipe\multifunplayer-mpv (the MFP convention,
 *   so MFP can attach to the same mpv). Test hook: FSMGR_MPV_PIPE overrides
 *   the pipe name so smokes never collide with a live MFP.
 * - Hand-rolled: net.connect + line-delimited JSON + request_id matching
 *   (node-mpv is unmaintained). One long-lived connection per client; a
 *   dropped connection loses observe registrations, so consumers reconnect
 *   with a fresh client instead of resuming this one.
 */

/** Effective pipe name (env override is a test hook). */
export function mpvPipeName(): string {
  return process.env['FSMGR_MPV_PIPE'] || MPV_PIPE_NAME
}

export function mpvPipePath(): string {
  return `\\\\.\\pipe\\${mpvPipeName()}`
}

interface PendingRequest {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
}

export interface MpvEventMessage {
  event: string
  [key: string]: unknown
}

export interface MpvClientEvents {
  /** Any mpv event (property-change events are also routed to observers). */
  event: (e: MpvEventMessage) => void
  close: () => void
}

export class MpvIpcClient extends EventEmitter {
  private buffer = ''
  private nextRequestId = 1
  private nextObserveId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly observers = new Map<number, (value: unknown) => void>()
  private closed = false

  private constructor(private readonly socket: Socket) {
    super()
    socket.setEncoding('utf-8')
    socket.on('data', (chunk) => this.onData(String(chunk)))
    const onGone = (): void => {
      if (this.closed) return
      this.closed = true
      const err = new Error('mpv connection closed')
      for (const req of this.pending.values()) req.reject(err)
      this.pending.clear()
      this.emit('close')
    }
    socket.on('close', onGone)
    socket.on('error', onGone)
  }

  override on<K extends keyof MpvClientEvents>(event: K, listener: MpvClientEvents[K]): this {
    return super.on(event, listener)
  }
  override emit<K extends keyof MpvClientEvents>(
    event: K,
    ...args: Parameters<MpvClientEvents[K]>
  ): boolean {
    return super.emit(event, ...args)
  }

  /** Connect to an mpv IPC pipe; rejects if it is not accepting connections. */
  static connect(pipePath: string = mpvPipePath(), timeoutMs = 2000): Promise<MpvIpcClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(pipePath)
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`mpv pipe connect timeout: ${pipePath}`))
      }, timeoutMs)
      socket.once('connect', () => {
        clearTimeout(timer)
        resolve(new MpvIpcClient(socket))
      })
      socket.once('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (!line) continue
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line)
      } catch {
        continue // tolerate garbage on a shared pipe
      }
      if (typeof msg['request_id'] === 'number' && msg['request_id'] !== 0) {
        const req = this.pending.get(msg['request_id'])
        if (req) {
          this.pending.delete(msg['request_id'])
          if (msg['error'] === 'success') req.resolve(msg['data'])
          else req.reject(new Error(`mpv: ${String(msg['error'])}`))
        }
        continue
      }
      if (typeof msg['event'] === 'string') {
        if (msg['event'] === 'property-change' && typeof msg['id'] === 'number') {
          this.observers.get(msg['id'])?.(msg['data'])
        }
        this.emit('event', msg as unknown as MpvEventMessage)
      }
    }
  }

  /** Send a command array, e.g. command('loadfile', path, 'replace'). */
  command<T = unknown>(...cmd: unknown[]): Promise<T> {
    if (this.closed) return Promise.reject(new Error('mpv connection closed'))
    const requestId = this.nextRequestId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { resolve: resolve as (d: unknown) => void, reject })
      this.socket.write(`${JSON.stringify({ command: cmd, request_id: requestId })}\n`, (err) => {
        if (err) {
          this.pending.delete(requestId)
          reject(err)
        }
      })
    })
  }

  getProperty<T = unknown>(name: string): Promise<T> {
    return this.command<T>('get_property', name)
  }

  setProperty(name: string, value: unknown): Promise<unknown> {
    return this.command('set_property', name, value)
  }

  /** Observe a property; the callback fires on every change (and once initially). */
  async observeProperty(name: string, onChange: (value: unknown) => void): Promise<number> {
    const id = this.nextObserveId++
    this.observers.set(id, onChange)
    await this.command('observe_property', id, name)
    return id
  }

  get isClosed(): boolean {
    return this.closed
  }

  close(): void {
    this.closed = true
    this.socket.destroy()
  }
}

export interface MpvTimeSample {
  /** time-pos reported by mpv (seconds). */
  pos: number
  /** performance.now() at sample time (milliseconds). */
  sampledAt: number
  speed: number
  paused: boolean
}

/** Extrapolate the current playback position (ms) from the latest sample. */
export function extrapolatePositionMs(sample: MpvTimeSample, nowMs: number): number {
  if (sample.paused) return sample.pos * 1000
  return sample.pos * 1000 + (nowMs - sample.sampledAt) * sample.speed
}

/**
 * Playback clock: time-pos events are frame-granular plus pipe
 * jitter, so the clock keeps the latest (pos, wallclock) sample and
 * extrapolates while playing. Seek/restart events reset the baseline via
 * fresh time-pos samples that follow them.
 */
export class PlaybackClock {
  private sample: MpvTimeSample | null = null
  /**
   * How long the file is, in seconds. Not extrapolated — it is a property of
   * the file, not of time passing — but kept here because everything else that
   * asks "where are we" asks this object, and a scrubber needs both halves.
   */
  private duration: number | null = null
  /** mpv's volume, mirrored so the bar can show it without a round trip. */
  private volume: number | null = null

  /** Register the observers this clock needs. Call once per client. */
  async attach(client: MpvIpcClient): Promise<void> {
    let speed = 1
    let paused = true
    const resample = (pos: unknown): void => {
      if (typeof pos !== 'number') {
        this.sample = null // e.g. between files
        return
      }
      this.sample = { pos, sampledAt: performance.now(), speed, paused }
    }
    await client.observeProperty('speed', (v) => {
      if (typeof v === 'number') speed = v
      if (this.sample) this.sample = { ...this.sample, speed, sampledAt: performance.now(), pos: this.positionSeconds() ?? this.sample.pos }
    })
    await client.observeProperty('pause', (v) => {
      if (typeof v === 'boolean') {
        // Freeze/unfreeze at the extrapolated position.
        const pos = this.positionSeconds()
        paused = v
        if (this.sample && pos !== null) {
          this.sample = { pos, sampledAt: performance.now(), speed, paused }
        }
      }
    })
    await client.observeProperty('time-pos', resample)
    await client.observeProperty('duration', (v) => {
      this.duration = typeof v === 'number' && v > 0 ? v : null
    })
    await client.observeProperty('volume', (v) => {
      this.volume = typeof v === 'number' ? v : null
    })
    client.on('event', (e) => {
      // A seek invalidates extrapolation until the next time-pos sample.
      if (e.event === 'seek') this.sample = null
    })
    client.on('close', () => {
      this.sample = null
      this.duration = null
    })
  }

  /** Extrapolated position in seconds, or null when unknown (idle/seeking). */
  positionSeconds(): number | null {
    if (!this.sample) return null
    return extrapolatePositionMs(this.sample, performance.now()) / 1000
  }

  positionMs(): number | null {
    const s = this.positionSeconds()
    return s === null ? null : s * 1000
  }

  durationSeconds(): number | null {
    return this.duration
  }

  durationMs(): number | null {
    return this.duration === null ? null : this.duration * 1000
  }

  volumePercent(): number | null {
    return this.volume
  }

  get paused(): boolean | null {
    return this.sample?.paused ?? null
  }
}
