import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { AppError } from '@shared/errors'
import { STREAM_TIME_OFFSET_S } from '@shared/constants'
import type { StreamRoute } from '@shared/schemas/playback'
import { runnableFfmpeg } from '../../deps/binaries'
import { findByAbsPath } from '../../library/library-manager'
import { videoEncoderArgs } from './encoder'

/**
 * ffmpeg rewriting a file, on the fly, into fragmented MP4 the picture can
 * feed to a MediaSource.
 *
 * Every timestamp in the output is the source's own: a frame the source shows
 * at 7.3s is at 7.3s in the stream, whichever position the stream was started
 * from. That is what keeps the device on the picture, and each of these is
 * needed for it:
 *
 * - `-copyts -start_at_zero` keep source times, counted from the file's start
 *   the way every player counts them.
 * - `frag_discont` writes those times into each fragment as they are; without
 *   it the muxer counts from zero again on every start.
 * - `negative_cts_offsets` lets a B-frame video keep its first frame at its
 *   own time instead of being pushed late by its reorder delay.
 * - `delay_moov` holds the header back until the first packets are read. An
 *   MPEG-TS source only reveals its AAC setup in those packets, and a header
 *   written before them leaves the audio undecodable.
 * - `-output_ts_offset` moves everything forward by a fixed amount, see
 *   `STREAM_TIME_OFFSET_S`.
 *
 * A stream is read over IPC by the window that opened it, one read at a time,
 * and ffmpeg only runs as fast as those reads: it blocks on a full pipe while
 * the picture has enough buffered.
 */

const MOVFLAGS = 'frag_keyframe+empty_moov+default_base_moof+frag_discont+negative_cts_offsets+delay_moov'

/** How late a copied stream may begin after the position asked for. */
const LATE_TOLERANCE_S = 0.05
/** Starts from further back before settling for a late one. */
const MAX_ATTEMPTS = 6
/** No playable output by now means this file is not going to produce any. */
const FIRST_FRAGMENT_TIMEOUT_MS = 30_000
/** One read hands over at most about this much. */
const READ_BYTES = 2 * 1024 * 1024
/** …or whatever arrived within this long of the first chunk. */
const READ_GATHER_MS = 15

interface LiveStream {
  owner: WebContents
  proc: ChildProcess
  pending: Buffer[]
  pendingBytes: number
  ended: boolean
  /** The read waiting for data, if one is. */
  wake: (() => void) | null
  gather: NodeJS.Timeout | null
}

const streams = new Map<string, LiveStream>()
/** Newest open per window, so an open overtaken by the next one gives up. */
const opening = new Map<WebContents, number>()
const watched = new WeakSet<WebContents>()

export async function openStream(
  owner: WebContents,
  { path, startMs, route }: { path: string; startMs: number; route: StreamRoute }
): Promise<string> {
  const found = findByAbsPath(path)
  if (!found) throw new AppError('media_not_found')
  const abs = join(found.libraryRoot, found.mediaRelPath)
  const ffmpeg = await runnableFfmpeg()
  if (!ffmpeg) throw new AppError('ffmpeg_unavailable')

  // The picture shows one file; whatever this window was reading is finished.
  closeStreamsOf(owner)
  const turn = (opening.get(owner) ?? 0) + 1
  opening.set(owner, turn)
  const overtaken = (): boolean => opening.get(owner) !== turn || owner.isDestroyed()

  const videoArgs =
    route.video === 'encode'
      ? await videoEncoderArgs(ffmpeg)
      : ['-c:v', 'copy', ...(route.videoCodec === 'hevc' ? ['-tag:v', 'hvc1'] : [])]
  const audioArgs =
    route.audio === 'none'
      ? ['-an']
      : route.audio === 'copy'
        ? // A no-op on AAC that is not in ADTS framing, so it is always safe.
          ['-map', '0:a:0?', '-c:a', 'copy', '-bsf:a', 'aac_adtstoasc']
        : ['-map', '0:a:0?', '-c:a', 'aac', '-b:a', '192k', '-ac', '2']
  const argsFrom = (fromS: number): string[] => [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    // Seeking to 0 in some containers (FLV) lands somewhere else entirely.
    ...(fromS > 0 ? ['-ss', fromS.toFixed(3)] : []),
    '-copyts', '-start_at_zero',
    '-i', abs,
    // Capital V: a cover image stored as a video stream is not the video.
    '-map', '0:V:0',
    ...videoArgs,
    ...audioArgs,
    '-output_ts_offset', String(STREAM_TIME_OFFSET_S),
    '-f', 'mp4', '-movflags', MOVFLAGS,
    'pipe:1'
  ]

  const target = startMs / 1000
  let lead = 0
  for (let attempt = 1; ; attempt++) {
    const from = Math.max(0, target - lead)
    const started = await startAttempt(ffmpeg, argsFrom(from))
    if (overtaken()) {
      started.proc.kill()
      throw new AppError('stream_failed')
    }
    // Copying cannot start between keyframes, and some containers (MPEG-TS)
    // seek to the keyframe *after* the position rather than before it — which
    // would leave the picture showing a later frame than the script is at.
    // Converting starts exactly where asked. Either way, a seek past the last
    // keyframe produces nothing, and starting further back fixes that too.
    const late =
      started.firstS === null ||
      (route.video === 'copy' && started.firstS > target + LATE_TOLERANCE_S)
    if (late && from > 0 && attempt < MAX_ATTEMPTS) {
      started.proc.kill()
      lead = lead === 0 ? 2 : lead * 2
      continue
    }
    if (started.firstS === null) {
      started.proc.kill()
      console.error(`[player] ffmpeg produced nothing to play for ${abs}: ${started.stderr().trim()}`)
      throw new AppError('stream_failed')
    }
    return register(owner, started.proc, started.head, started.stderr)
  }
}

/** The next bytes of a stream, or null once it has all been read. */
export async function readStream(
  owner: WebContents,
  id: string
): Promise<Uint8Array<ArrayBuffer> | null> {
  const stream = streams.get(id)
  if (!stream || stream.owner !== owner) return null
  if (stream.pending.length === 0 && !stream.ended) {
    await new Promise<void>((resolve) => {
      stream.wake = resolve
      stream.proc.stdout?.resume()
    })
  }
  if (stream.pending.length === 0) return null
  // A fresh allocation, never a shared one.
  const chunk = Buffer.concat(stream.pending) as Uint8Array<ArrayBuffer>
  stream.pending = []
  stream.pendingBytes = 0
  return chunk
}

export function closeStream(owner: WebContents, id: string): void {
  const stream = streams.get(id)
  if (!stream || stream.owner !== owner) return
  end(id, stream)
}

/** Every ffmpeg still running for the picture; the app is quitting. */
export function disposeVideoStreams(): void {
  for (const [id, stream] of streams) end(id, stream)
}

function closeStreamsOf(owner: WebContents): void {
  for (const [id, stream] of streams) if (stream.owner === owner) end(id, stream)
}

function end(id: string, stream: LiveStream): void {
  streams.delete(id)
  if (stream.gather) clearTimeout(stream.gather)
  stream.proc.kill()
  stream.ended = true
  stream.wake?.()
  stream.wake = null
}

function register(
  owner: WebContents,
  proc: ChildProcess,
  head: Buffer[],
  stderr: () => string
): string {
  const id = randomUUID()
  const stream: LiveStream = {
    owner,
    proc,
    pending: head,
    pendingBytes: head.reduce((sum, b) => sum + b.length, 0),
    // A short file can be written out in full before anyone listens for the end.
    ended: proc.stdout?.readableEnded ?? true,
    wake: null,
    gather: null
  }
  streams.set(id, stream)

  const hand = (): void => {
    if (stream.gather) clearTimeout(stream.gather)
    stream.gather = null
    // Paused between reads: ffmpeg stops once the pipe fills, which is what
    // keeps it from converting a whole film into memory ahead of the picture.
    proc.stdout?.pause()
    const wake = stream.wake
    stream.wake = null
    wake?.()
  }
  proc.stdout?.on('data', (chunk: Buffer) => {
    stream.pending.push(chunk)
    stream.pendingBytes += chunk.length
    // A pipe read is small; handing each one over on its own would cost an
    // IPC round trip per 64 KB, slower than a high-bitrate film plays.
    if (stream.pendingBytes >= READ_BYTES) hand()
    else if (!stream.gather) stream.gather = setTimeout(hand, READ_GATHER_MS)
  })
  proc.stdout?.on('end', () => {
    stream.ended = true
    hand()
  })
  proc.on('close', (code, signal) => {
    stream.ended = true
    hand()
    if (code !== 0 && signal === null && streams.has(id)) {
      console.error(`[player] ffmpeg stream exited with ${code}: ${stderr().trim()}`)
    }
  })

  if (!watched.has(owner)) {
    watched.add(owner)
    owner.once('destroyed', () => closeStreamsOf(owner))
  }
  return id
}

interface Attempt {
  proc: ChildProcess
  /** What was read while looking for the first video fragment. */
  head: Buffer[]
  /** Source time of the first video frame; null when ffmpeg made none. */
  firstS: number | null
  stderr: () => string
}

/** Start ffmpeg and read until the first video fragment says where it begins. */
function startAttempt(ffmpeg: string, args: string[]): Promise<Attempt> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let errText = ''
    proc.stderr?.on('data', (d: Buffer) => {
      // The end is what explains a failure; keep that much of it.
      errText = (errText + d.toString()).slice(-4000)
    })
    const stderr = (): string => errText
    const head: Buffer[] = []
    let settled = false
    const settle = (firstS: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      proc.stdout?.pause()
      proc.stdout?.off('data', onData)
      resolve({ proc, head, firstS, stderr })
    }
    const onData = (chunk: Buffer): void => {
      head.push(chunk)
      const firstS = firstVideoTime(Buffer.concat(head))
      if (firstS !== undefined) settle(firstS)
    }
    const timer = setTimeout(() => {
      proc.kill()
      settle(null)
    }, FIRST_FRAGMENT_TIMEOUT_MS)
    proc.stdout?.on('data', onData)
    proc.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      console.error('[player] ffmpeg did not start:', e)
      reject(new AppError('ffmpeg_unavailable'))
    })
    proc.on('close', () => settle(null))
  })
}

/*
 * Just enough of ISO BMFF to read the head of our own output: the video
 * track's id and timescale from `moov`, then the earliest presentation time in
 * the first `moof` that carries that track.
 */

interface Box {
  type: string
  body: number
  end: number
}

function boxAt(buf: Buffer, at: number, limit: number): Box | null {
  if (at + 8 > limit) return null
  const size = buf.readUInt32BE(at)
  if (size < 8 || at + size > limit) return null
  return { type: buf.toString('latin1', at + 4, at + 8), body: at + 8, end: at + size }
}

function children(buf: Buffer, box: Box): Box[] {
  const found: Box[] = []
  for (let at = box.body; ; ) {
    const child = boxAt(buf, at, box.end)
    if (!child) return found
    found.push(child)
    at = child.end
  }
}

const child = (buf: Buffer, box: Box, type: string): Box | undefined =>
  children(buf, box).find((b) => b.type === type)

/** Seconds in source time; undefined while the fragment has not all arrived. */
function firstVideoTime(buf: Buffer): number | undefined {
  let videoTrack: number | null = null
  let timescale = 0
  for (let at = 0; ; ) {
    const top = boxAt(buf, at, buf.length)
    if (!top) return undefined
    at = top.end
    if (top.type === 'moov') {
      for (const trak of children(buf, top).filter((b) => b.type === 'trak')) {
        const tkhd = child(buf, trak, 'tkhd')
        const mdia = child(buf, trak, 'mdia')
        const hdlr = mdia && child(buf, mdia, 'hdlr')
        const mdhd = mdia && child(buf, mdia, 'mdhd')
        if (!tkhd || !hdlr || !mdhd) continue
        if (buf.toString('latin1', hdlr.body + 8, hdlr.body + 12) !== 'vide') continue
        videoTrack = buf.readUInt32BE(tkhd.body + (buf[tkhd.body] === 1 ? 20 : 12))
        timescale = buf.readUInt32BE(mdhd.body + (buf[mdhd.body] === 1 ? 20 : 12))
      }
      continue
    }
    if (top.type !== 'moof' || videoTrack === null || timescale === 0) continue
    for (const traf of children(buf, top).filter((b) => b.type === 'traf')) {
      const tfhd = child(buf, traf, 'tfhd')
      const tfdt = child(buf, traf, 'tfdt')
      const trun = child(buf, traf, 'trun')
      if (!tfhd || !tfdt || !trun || buf.readUInt32BE(tfhd.body + 4) !== videoTrack) continue
      return earliestPresentation(buf, tfhd, tfdt, trun) / timescale - STREAM_TIME_OFFSET_S
    }
  }
}

function earliestPresentation(buf: Buffer, tfhd: Box, tfdt: Box, trun: Box): number {
  const tfhdFlags = buf.readUInt32BE(tfhd.body) & 0xffffff
  let at = tfhd.body + 8
  if (tfhdFlags & 0x1) at += 8
  if (tfhdFlags & 0x2) at += 4
  const defaultDuration = tfhdFlags & 0x8 ? buf.readUInt32BE(at) : 0

  let decodeTime =
    buf[tfdt.body] === 1 ? Number(buf.readBigUInt64BE(tfdt.body + 4)) : buf.readUInt32BE(tfdt.body + 4)

  const version = buf[trun.body]
  const flags = buf.readUInt32BE(trun.body) & 0xffffff
  const count = buf.readUInt32BE(trun.body + 4)
  let p = trun.body + 8
  if (flags & 0x1) p += 4
  if (flags & 0x4) p += 4
  let earliest = Infinity
  for (let i = 0; i < count; i++) {
    let duration = defaultDuration
    let offset = 0
    if (flags & 0x100) {
      duration = buf.readUInt32BE(p)
      p += 4
    }
    if (flags & 0x200) p += 4
    if (flags & 0x400) p += 4
    if (flags & 0x800) {
      offset = version === 1 ? buf.readInt32BE(p) : buf.readUInt32BE(p)
      p += 4
    }
    earliest = Math.min(earliest, decodeTime + offset)
    decodeTime += duration
  }
  return earliest
}
