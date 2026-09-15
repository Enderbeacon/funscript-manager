import { AppError } from '@shared/errors'
import { MpvIpcClient } from '../mpv/mpv-ipc'
import { ensureMpv } from '../mpv/mpv-process'
import { BaseMediaSource } from './base'
import { MediaClock } from './clock'
import { EMPTY_READING, type ConnectOptions, type MediaSourceAdapter, type MediaSourceCapabilities, type MediaSourceReading } from './port'

/**
 * mpv as one of the players.
 *
 * The pipe is shared with MultiFunPlayer, so connecting means attaching to
 * whatever is already on it before starting anything of our own — that is
 * what makes the MFP script route work at all.
 */
export class MpvSource extends BaseMediaSource implements MediaSourceAdapter {
  readonly kind = 'mpv' as const
  readonly capabilities: MediaSourceCapabilities = {
    open: true,
    seek: true,
    pause: true,
    volume: true,
    launch: true
  }

  private client: MpvIpcClient | null = null
  private readonly clock = new MediaClock()
  /** The file we last reported; mpv re-announces `path` on every reload. */
  private lastPath: string | null = null
  /** Guard so one finished file is reported once, not on every eof event. */
  private endedFor: string | null = null

  constructor(private readonly exePath: string) {
    super()
  }

  async connect({ launch }: ConnectOptions): Promise<void> {
    if (this.client && !this.client.isClosed) return
    // Attaching to a live mpv always comes first: it may be the user's, or the
    // one MFP started, and a second instance would take the pipe from neither.
    let client: MpvIpcClient | null = null
    try {
      client = await MpvIpcClient.connect()
    } catch {
      if (!launch) throw new AppError('player_unreachable')
      client = (await ensureMpv(this.exePath)).client
    }
    this.client = client
    await this.attach(client)
  }

  private async attach(client: MpvIpcClient): Promise<void> {
    await client.observeProperty('time-pos', (v) =>
      this.clock.setPosition(typeof v === 'number' ? v * 1000 : null)
    )
    await client.observeProperty('pause', (v) => {
      if (typeof v === 'boolean') this.clock.setPaused(v)
    })
    await client.observeProperty('speed', (v) => {
      if (typeof v === 'number') this.clock.setSpeed(v)
    })
    await client.observeProperty('duration', (v) =>
      this.clock.setDuration(typeof v === 'number' ? v * 1000 : null)
    )
    await client.observeProperty('volume', (v) =>
      this.clock.setVolume(typeof v === 'number' ? v : null)
    )
    await client.observeProperty('path', (v) => {
      this.notePath(typeof v === 'string' && v.trim() ? v : null)
    })
    /*
     * mpv runs with `--keep-open`, ours and the one MFP starts alike (checked
     * against MFP 1.32, 2026-07-22), so reaching the end never unloads the file and `end-file`
     * never arrives — mpv pauses on the last frame and sets this instead.
     * Seeking into the last second sets it too, hence the duration check.
     */
    await client.observeProperty('eof-reached', (v) => {
      if (v !== true) return
      const path = this.clock.path()
      if (path === null || this.endedFor === path) return
      const position = this.clock.positionMs()
      const duration = this.clock.durationMs()
      if (position !== null && duration !== null && duration - position > 2000) return
      this.endedFor = path
      this.emit('ended')
    })
    client.on('event', (e) => {
      if (e.event === 'seek') this.clock.invalidatePosition()
      if (e.event === 'idle') this.notePath(null)
    })
    client.on('close', () => {
      this.client = null
      this.clock.reset()
      this.lastPath = null
      this.emit('closed')
    })
  }

  private notePath(path: string | null): void {
    if (path === this.lastPath) return
    this.lastPath = path
    this.endedFor = null
    this.clock.setPath(path)
    if (path === null) this.clock.reset()
    this.emit('path-changed', { path })
  }

  async disconnect(): Promise<void> {
    const client = this.client
    this.client = null
    this.clock.reset()
    this.lastPath = null
    // Closing our end never closes the user's mpv; it is their window.
    client?.close()
  }

  read(): MediaSourceReading {
    if (!this.client || this.client.isClosed) return EMPTY_READING
    return {
      path: this.clock.path(),
      positionMs: this.clock.positionMs(),
      durationMs: this.clock.durationMs(),
      paused: this.clock.paused,
      volume: this.clock.volumePercent()
    }
  }

  private require(): MpvIpcClient {
    if (!this.client || this.client.isClosed) throw new AppError('player_unreachable')
    return this.client
  }

  async open(path: string, startAtMs: number | null): Promise<void> {
    await loadFile(this.require(), path, startAtMs === null ? null : startAtMs / 1000)
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.require().setProperty('pause', paused)
  }

  async seek(positionMs: number): Promise<void> {
    await this.require().setProperty('time-pos', positionMs / 1000)
  }

  async setVolume(volume: number): Promise<void> {
    await this.require().setProperty('volume', volume)
  }
}

/**
 * `loadfile` argument order changed in mpv 0.38: an `index` argument was
 * inserted before the options string (`loadfile <url> <flags> <index>
 * <options>`); older builds take the options in that slot and reject the new
 * form with "invalid parameter" — and vice versa. We do not control which mpv
 * this is (MFP may have started it), so try the current form, fall back to the
 * legacy one, and finally to a plain load plus a seek. The form that worked is
 * remembered so the fallback costs one round trip per mpv, not per play.
 */
type LoadfileForm = 'indexed' | 'legacy' | 'seek'
let loadfileForm: LoadfileForm | null = null

/** Seek retry: `time-pos` is unavailable for a moment after loadfile. */
async function seekTo(mpv: MpvIpcClient, seconds: number): Promise<void> {
  const deadline = Date.now() + 3000
  for (;;) {
    try {
      await mpv.setProperty('time-pos', seconds)
      return
    } catch (e) {
      if (Date.now() > deadline) throw e
      await new Promise((r) => setTimeout(r, 150))
    }
  }
}

async function loadFile(mpv: MpvIpcClient, path: string, startAt: number | null): Promise<void> {
  if (startAt === null) {
    await mpv.command('loadfile', path, 'replace')
    return
  }
  const start = `start=${startAt.toFixed(3)}`
  const forms: LoadfileForm[] = loadfileForm ? [loadfileForm] : ['indexed', 'legacy', 'seek']
  let lastError: unknown = null
  for (const form of forms) {
    try {
      if (form === 'indexed') await mpv.command('loadfile', path, 'replace', 0, start)
      else if (form === 'legacy') await mpv.command('loadfile', path, 'replace', start)
      else {
        await mpv.command('loadfile', path, 'replace')
        await seekTo(mpv, startAt)
      }
      loadfileForm = form
      return
    } catch (e) {
      lastError = e
    }
  }
  // Every form failed: the resume is not worth losing the playback over.
  console.error('[mpv] loadfile with a start position failed, loading from the top:', lastError)
  loadfileForm = null
  await mpv.command('loadfile', path, 'replace')
}
