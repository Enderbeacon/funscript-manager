import { STREAM_TIME_OFFSET_S } from '@shared/constants'
import type { StreamRoute } from '@shared/schemas/playback'
import { ipcInvoke } from './ipc'

/**
 * Feeds the picture a file that ffmpeg is rewriting as it goes.
 *
 * The element plays a MediaSource, and this fills it from a stream the main
 * process reads out of ffmpeg. Stream times are the source's own, so seeking
 * is the element's ordinary seek: a position already buffered just plays, and
 * one that is not starts ffmpeg again from there. The element's clock is
 * therefore the file's clock, which is what the playback clock and the device
 * read.
 */

/** How far ahead of the playhead to read before waiting. */
const AHEAD_S = 30
/** How much already played to keep, for small seeks back. */
const BEHIND_S = 10
/** While waiting for room: the playhead has to move before anything changes. */
const WAIT_MS = 250

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const settled = (buffer: SourceBuffer): Promise<void> =>
  buffer.updating
    ? new Promise((resolve) => buffer.addEventListener('updateend', () => resolve(), { once: true }))
    : Promise.resolve()

export class StreamFeed {
  private readonly source = new MediaSource()
  private buffer: SourceBuffer | null = null
  /** Bumped by every restart and by disposal; a pump from an older one stops. */
  private generation = 0
  private streamId: string | null = null
  /** Where the running stream was asked to start. */
  private target: number | null = null
  private disposed = false

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly path: string,
    private readonly route: StreamRoute,
    /** A stream ffmpeg could not make, or one the element could not take. */
    private readonly onFail: (error: unknown) => void
  ) {}

  /** Attach to the element and start at this position, in seconds. */
  start(atS: number): void {
    this.video.addEventListener('seeking', this.onSeeking)
    this.source.addEventListener(
      'sourceopen',
      () => {
        if (this.disposed) return
        URL.revokeObjectURL(this.video.src)
        if (this.route.durationMs !== null) this.source.duration = this.route.durationMs / 1000
        try {
          this.buffer = this.source.addSourceBuffer(this.route.mimeType)
        } catch (e) {
          this.onFail(e)
          return
        }
        // Undoes the offset the main process puts on every stream time.
        this.buffer.timestampOffset = -STREAM_TIME_OFFSET_S
        this.buffer.addEventListener('error', () => this.onFail(new Error('source buffer error')))
        this.video.currentTime = atS
        void this.restart(atS)
      },
      { once: true }
    )
    this.video.src = URL.createObjectURL(this.source)
  }

  dispose(): void {
    this.disposed = true
    this.generation++
    this.video.removeEventListener('seeking', this.onSeeking)
    this.closeStream()
  }

  private readonly onSeeking = (): void => {
    const at = this.video.currentTime
    if (this.covers(at)) return
    // Seeking again to where the running stream is already headed.
    if (this.target !== null && Math.abs(this.target - at) < 0.01) return
    void this.restart(at)
  }

  private covers(at: number): boolean {
    const ranges = this.video.buffered
    for (let i = 0; i < ranges.length; i++) {
      if (at >= ranges.start(i) && at < ranges.end(i) - 0.1) return true
    }
    return false
  }

  private closeStream(): void {
    if (this.streamId) void ipcInvoke('video:streamClose', { id: this.streamId }).catch(() => {})
    this.streamId = null
  }

  private async restart(atS: number): Promise<void> {
    const buffer = this.buffer
    if (!buffer || this.disposed) return
    const generation = ++this.generation
    this.target = atS
    this.closeStream()

    await settled(buffer)
    if (generation !== this.generation) return
    try {
      // What is buffered belongs to the stream being replaced. An ended source
      // reopens on `remove`; only an open one has a half-read segment to drop.
      if (this.source.readyState === 'open') buffer.abort()
      if (buffer.buffered.length > 0) {
        buffer.remove(0, Infinity)
        await settled(buffer)
      }
    } catch (e) {
      this.onFail(e)
      return
    }
    if (generation !== this.generation) return

    let id: string
    try {
      ;({ id } = await ipcInvoke('video:streamOpen', {
        path: this.path,
        startMs: atS * 1000,
        route: this.route
      }))
    } catch (e) {
      if (generation === this.generation) this.onFail(e)
      return
    }
    if (generation !== this.generation) {
      void ipcInvoke('video:streamClose', { id }).catch(() => {})
      return
    }
    this.streamId = id
    void this.pump(generation, id, buffer)
  }

  private async pump(generation: number, id: string, buffer: SourceBuffer): Promise<void> {
    const current = (): boolean => generation === this.generation
    try {
      while (current()) {
        if (this.aheadS(buffer) > AHEAD_S) {
          await sleep(WAIT_MS)
          continue
        }
        const { chunk } = await ipcInvoke('video:streamRead', { id })
        if (!current()) return
        if (!chunk) {
          await settled(buffer)
          // Without this the element waits at the end for data that is not
          // coming, and never says the file ended.
          if (current() && this.source.readyState === 'open') this.source.endOfStream()
          return
        }
        await this.append(buffer, chunk, current)
      }
    } catch (e) {
      if (current()) this.onFail(e)
    }
  }

  private aheadS(buffer: SourceBuffer): number {
    const ranges = buffer.buffered
    return ranges.length === 0 ? 0 : ranges.end(ranges.length - 1) - this.video.currentTime
  }

  /**
   * Append, making room when the element's memory allowance is used up.
   *
   * The allowance is a size, not a duration, so a high-bitrate file can fill
   * it with less than `AHEAD_S` buffered. Dropping what has already played is
   * the first answer; when there is nothing left to drop, waiting for the
   * playhead to use some of it is the second.
   */
  private async append(
    buffer: SourceBuffer,
    chunk: Uint8Array<ArrayBuffer>,
    current: () => boolean
  ): Promise<void> {
    for (;;) {
      await settled(buffer)
      if (!current()) return
      const keepFrom = this.video.currentTime - BEHIND_S
      const ranges = buffer.buffered
      try {
        if (ranges.length > 0 && ranges.start(0) < keepFrom - 5) {
          buffer.remove(0, keepFrom)
          await settled(buffer)
          if (!current()) return
        }
        buffer.appendBuffer(chunk)
        await settled(buffer)
        return
      } catch (e) {
        if (!(e instanceof DOMException && e.name === 'QuotaExceededError')) throw e
        await sleep(WAIT_MS)
      }
    }
  }
}
