import { spawn } from 'node:child_process'
import { resolveFfmpeg } from '../deps/binaries'

/**
 * What a media file says about itself: duration, size on screen, codecs.
 *
 * Read with `ffmpeg -i`, not ffprobe. They report the same thing, but ffprobe
 * is a second binary — the FFmpeg-Builds zip carries it and ffmpeg-static does
 * not, so relying on it would mean the bundled copy silently has no probing.
 * `ffmpeg -i` with no output file prints the banner and exits non-zero, which
 * is exactly the information wanted and costs one header read.
 */

export interface MediaInfo {
  durationMs?: number
  width?: number
  height?: number
  videoCodec?: string
  audioCodec?: string
}

/** `Duration: 00:32:18.24, start: …` */
const DURATION = /Duration:\s*(\d+):(\d\d):(\d\d)\.(\d+)/
/** `Stream #0:0[0x1](und): Video: hevc (Main 10) (hvc1 / …), yuv420p, 3840x1920 …` */
const VIDEO = /Stream #\d+:\d+.*?:\s*Video:\s*([\w-]+)/
const AUDIO = /Stream #\d+:\d+.*?:\s*Audio:\s*([\w-]+)/
/** The frame size, taken from the video stream line only. */
const SIZE = /,\s*(\d{2,5})x(\d{2,5})\b/

export function parseFfmpegBanner(text: string): MediaInfo {
  const info: MediaInfo = {}

  const duration = DURATION.exec(text)
  if (duration) {
    const [, h, m, s, frac] = duration
    // The fractional part is centiseconds in every build seen; padding makes
    // that assumption harmless if one ever prints milliseconds.
    const ms = Number(`0.${frac}`) * 1000
    info.durationMs = Math.round(
      (Number(h) * 3600 + Number(m) * 60 + Number(s)) * 1000 + ms
    )
  }

  const videoLine = text.split(/\r?\n/).find((line) => VIDEO.test(line))
  if (videoLine) {
    info.videoCodec = VIDEO.exec(videoLine)?.[1]
    const size = SIZE.exec(videoLine)
    if (size) {
      info.width = Number(size[1])
      info.height = Number(size[2])
    }
  }

  const audio = AUDIO.exec(text)
  if (audio) info.audioCodec = audio[1]

  return info
}

/**
 * Probe one file. Null when ffmpeg could not be run at all; an empty object
 * when it ran and the file told it nothing. Neither is an error anyone has to
 * see — "not known" is a normal state for a library.
 */
export async function probeMedia(absPath: string): Promise<MediaInfo | null> {
  const ffmpeg = await resolveFfmpeg()
  if (!ffmpeg) return null

  const banner = await new Promise<string>((resolve) => {
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(ffmpeg, ['-hide_banner', '-i', absPath], {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true
      })
    } catch {
      resolve('')
      return
    }
    let text = ''
    // A file whose headers are damaged can keep ffmpeg searching; the header
    // read this needs is done long before this fires.
    const timer = setTimeout(() => proc.kill(), 20_000)
    proc.stderr?.on('data', (chunk: Buffer) => (text += chunk.toString()))
    proc.on('error', () => {
      clearTimeout(timer)
      resolve('')
    })
    proc.on('close', () => {
      clearTimeout(timer)
      resolve(text)
    })
  })

  // An empty object and null mean different things to the caller: ffmpeg ran
  // and this file has nothing to report (record it, stop asking), versus
  // ffmpeg never ran (leave it unprobed so installing ffmpeg fixes it).
  return banner ? parseFfmpegBanner(banner) : null
}
