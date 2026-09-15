import { createConnection, type Socket } from 'node:net'
import { AppError } from '@shared/errors'
import { BaseMediaSource, looksFinished, toLocalPath } from './base'
import { MediaClock } from './clock'
import {
  EMPTY_READING,
  type ConnectOptions,
  type MediaSourceAdapter,
  type MediaSourceCapabilities,
  type MediaSourceReading
} from './port'

/**
 * HereSphere over its video-sync socket.
 *
 * Messages both ways are a 4-byte little-endian length followed by that many
 * bytes of UTF-8 JSON. HereSphere pushes its state whenever it changes and
 * expects a keep-alive — a bare zero length — about once a second; stop
 * sending it and it drops us.
 *
 * A zero-length message from its side means "nothing loaded", which is how
 * closing a video is announced.
 */

const KEEP_ALIVE_MS = 1000
/** HereSphere's own value for "playing"; everything else is not playing. */
const STATE_PLAYING = 0

interface HereSphereState {
  /**
   * It sends both, and they are not the same thing: `path` is a plain Windows
   * path, `resource` the same file as a `file://` URL. The path is what the
   * library can be searched by, so that is the one taken — the URL only
   * stands in for builds that send nothing else.
   */
  path?: unknown
  resource?: unknown
  playerState?: unknown
  duration?: unknown
  currentTime?: unknown
  playbackSpeed?: unknown
}

function frame(payload: Record<string, unknown>): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8')
  const header = Buffer.alloc(4)
  header.writeInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}

export class HereSphereSource extends BaseMediaSource implements MediaSourceAdapter {
  readonly kind = 'heresphere' as const
  readonly capabilities: MediaSourceCapabilities = {
    open: true,
    seek: true,
    pause: true,
    // The protocol carries no volume, and HereSphere's own is in the headset.
    volume: false,
    // It is a VR player the user is already wearing; starting it from here
    // would put a window on a screen nobody is looking at.
    launch: false
  }

  private socket: Socket | null = null
  private buffer = Buffer.alloc(0)
  private keepAlive: NodeJS.Timeout | null = null
  private readonly clock = new MediaClock()
  private lastPath: string | null = null
  private endedFor: string | null = null

  constructor(
    private readonly host: string,
    private readonly port: number
  ) {
    super()
  }

  connect(_opts: ConnectOptions): Promise<void> {
    if (this.socket) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.host, port: this.port })
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new AppError('player_unreachable'))
      }, 3000)
      socket.once('connect', () => {
        clearTimeout(timer)
        this.socket = socket
        this.buffer = Buffer.alloc(0)
        socket.on('data', (chunk: Buffer) => this.onData(chunk))
        socket.on('close', () => this.dropped())
        socket.on('error', () => this.dropped())
        this.keepAlive = setInterval(() => {
          this.socket?.write(Buffer.alloc(4))
        }, KEEP_ALIVE_MS)
        this.keepAlive.unref()
        resolve()
      })
      socket.once('error', () => {
        clearTimeout(timer)
        socket.destroy()
        reject(new AppError('player_unreachable'))
      })
    })
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      if (this.buffer.length < 4) return
      const length = this.buffer.readInt32LE(0)
      if (length <= 0) {
        this.buffer = this.buffer.subarray(4)
        this.notePath(null)
        continue
      }
      if (this.buffer.length < 4 + length) return
      const body = this.buffer.subarray(4, 4 + length).toString('utf-8')
      this.buffer = this.buffer.subarray(4 + length)
      try {
        this.apply(JSON.parse(body) as HereSphereState)
      } catch {
        // A frame we cannot read is not a reason to drop the connection.
      }
    }
  }

  private apply(state: HereSphereState): void {
    const path =
      toLocalPath(typeof state.path === 'string' ? state.path : null) ??
      toLocalPath(typeof state.resource === 'string' ? state.resource : null)
    if (path === null) {
      this.notePath(null)
      return
    }
    this.notePath(path)

    if (typeof state.duration === 'number' && state.duration >= 0) {
      this.clock.setDuration(state.duration * 1000)
    }
    if (typeof state.playbackSpeed === 'number' && state.playbackSpeed > 0) {
      this.clock.setSpeed(state.playbackSpeed)
    }
    if (typeof state.playerState === 'number') {
      this.clock.setPaused(state.playerState !== STATE_PLAYING)
    }
    if (typeof state.currentTime === 'number' && state.currentTime >= 0) {
      this.clock.setPosition(state.currentTime * 1000)
    }

    if (
      this.endedFor !== path &&
      this.clock.paused === true &&
      looksFinished(this.clock.positionMs(), this.clock.durationMs())
    ) {
      this.endedFor = path
      this.emit('ended')
    }
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

  private dropped(): void {
    if (!this.socket) return
    this.teardown()
    this.emit('closed')
  }

  private teardown(): void {
    if (this.keepAlive) clearInterval(this.keepAlive)
    this.keepAlive = null
    const socket = this.socket
    this.socket = null
    socket?.removeAllListeners()
    socket?.destroy()
    this.buffer = Buffer.alloc(0)
    this.clock.reset()
    this.lastPath = null
  }

  disconnect(): Promise<void> {
    this.teardown()
    return Promise.resolve()
  }

  read(): MediaSourceReading {
    if (!this.socket) return EMPTY_READING
    return {
      path: this.clock.path(),
      positionMs: this.clock.positionMs(),
      durationMs: this.clock.durationMs(),
      paused: this.clock.paused,
      volume: null
    }
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.socket) throw new AppError('player_unreachable')
    this.socket.write(frame(payload))
  }

  async open(path: string, startAtMs: number | null): Promise<void> {
    this.send({ path })
    if (startAtMs === null) return
    // Seeking before it has the file lands in the old one. It announces the
    // change itself, so wait for that rather than guessing at a delay.
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && this.clock.path() !== path) {
      await new Promise((r) => setTimeout(r, 100))
    }
    await this.seek(startAtMs)
  }

  setPaused(paused: boolean): Promise<void> {
    this.send({ playerState: paused ? 1 : STATE_PLAYING })
    return Promise.resolve()
  }

  seek(positionMs: number): Promise<void> {
    this.send({ currentTime: positionMs / 1000 })
    this.clock.setPosition(positionMs)
    return Promise.resolve()
  }

  setVolume(): Promise<void> {
    // Not offered (see `capabilities`), so nothing calls this.
    return Promise.resolve()
  }
}
