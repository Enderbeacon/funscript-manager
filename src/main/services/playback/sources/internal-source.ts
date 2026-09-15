import { basename } from 'node:path'
import { AppError } from '@shared/errors'
import type { InternalPlayerReport } from '@shared/schemas/playback'
import {
  hasVideoSurface,
  requestVideoSeek,
  resetVideoIntent,
  setVideoIntent,
  videoSurfaceEvents,
  waitForVideoSurface
} from '../internal/surface'
import { BaseMediaSource } from './base'
import { MediaClock } from './clock'
import {
  EMPTY_READING,
  type ConnectOptions,
  type MediaSourceAdapter,
  type MediaSourceCapabilities,
  type MediaSourceReading
} from './port'

/**
 * The picture this app draws itself.
 *
 * Every other player is a program we talk to; this one is a `<video>` in one
 * of our own windows. That difference stays inside this file — above the
 * player port it opens files, seeks and pauses like any other, which is what
 * lets the script player, the queue and the bar treat it as just another
 * choice in the list.
 *
 * "Connected" here means a window is drawing it. Nothing to launch, so
 * `launch` asks for the picture to be opened instead: the background scanner
 * passes false and therefore never makes a picture appear on its own.
 */
export class InternalSource extends BaseMediaSource implements MediaSourceAdapter {
  readonly kind = 'internal' as const
  readonly capabilities: MediaSourceCapabilities = {
    open: true,
    seek: true,
    pause: true,
    volume: true,
    launch: true
  }

  private connected = false
  private readonly clock = new MediaClock()
  /** The file we handed the picture; a report about any other one is stale. */
  private loadedPath: string | null = null
  /** So one finished file is reported once, however many reports repeat it. */
  private endedFor: string | null = null

  private readonly onReport = (report: InternalPlayerReport): void => {
    if (!this.connected) return
    // A report about a file we have already moved on from is in flight from
    // before the switch; acting on it would rewind the bar to the old video.
    if (report.path !== this.loadedPath) return
    // A file the picture cannot decode: it says so on screen itself, and
    // there is nothing here to report a position for.
    if (report.error) {
      this.clock.reset()
      return
    }
    this.clock.setDuration(report.durationMs)
    this.clock.setPaused(report.paused)
    this.clock.setPosition(report.positionMs)
    this.clock.setVolume(report.volume)
    if (report.ended && this.loadedPath !== null && this.endedFor !== this.loadedPath) {
      this.endedFor = this.loadedPath
      this.emit('ended')
    }
  }

  private readonly onLost = (): void => {
    if (!this.connected) return
    this.connected = false
    this.clock.reset()
    this.loadedPath = null
    this.emit('closed')
  }

  async connect({ launch }: ConnectOptions): Promise<void> {
    if (this.connected && hasVideoSurface()) return
    if (!hasVideoSurface()) {
      // Attaching to a picture that is already up costs nothing, but making
      // one appear is a window opening on the user's screen — only ever
      // because they asked to play something.
      if (!launch) throw new AppError('player_unreachable')
      setVideoIntent({ active: true })
      if (!(await waitForVideoSurface(5000))) {
        setVideoIntent({ active: false })
        throw new AppError('player_unreachable')
      }
    }
    setVideoIntent({ active: true })
    videoSurfaceEvents.on('report', this.onReport)
    videoSurfaceEvents.on('lost', this.onLost)
    this.connected = true
  }

  async disconnect(): Promise<void> {
    videoSurfaceEvents.off('report', this.onReport)
    videoSurfaceEvents.off('lost', this.onLost)
    this.connected = false
    this.clock.reset()
    this.loadedPath = null
    resetVideoIntent()
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

  /**
   * The picture is handed the path and nothing else. It loads over
   * `fsmgr-media://`, and that scheme decides whether the file is one this app
   * may serve — a file outside every library simply does not load, and says so
   * the same way an undecodable one does.
   */
  async open(path: string, startAtMs: number | null): Promise<void> {
    if (!this.connected) throw new AppError('player_unreachable')
    this.loadedPath = path
    this.endedFor = null
    this.clock.reset()
    this.clock.setPath(path)
    setVideoIntent({
      active: true,
      media: { path, fileName: basename(path) },
      seekMs: startAtMs !== null && startAtMs > 0 ? startAtMs : 0,
      paused: false,
      // The last video's subtitle is not this one's, and its nudge even less
      // so. Which subtitle this one gets is settled by the playback service,
      // which is the layer allowed to ask the library what this file has.
      subtitle: null,
      subtitleOffsetMs: 0
    })
    this.emit('path-changed', { path })
  }

  async setPaused(paused: boolean): Promise<void> {
    if (!this.connected) throw new AppError('player_unreachable')
    this.clock.setPaused(paused)
    setVideoIntent({ paused })
  }

  async seek(positionMs: number): Promise<void> {
    if (!this.connected) throw new AppError('player_unreachable')
    // Move the clock now rather than waiting for the picture to report back:
    // the bar is redrawn from it many times a second, and a dragged scrubber
    // that snapped back for a frame would read as the seek having failed.
    this.clock.setPosition(positionMs)
    requestVideoSeek(positionMs)
  }

  async setVolume(volume: number): Promise<void> {
    if (!this.connected) throw new AppError('player_unreachable')
    this.clock.setVolume(volume)
    setVideoIntent({ volume })
  }
}
