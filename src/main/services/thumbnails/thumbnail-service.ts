import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { LIBRARY_CACHE_DIR, VIDEO_EXTENSIONS } from '@shared/constants'
import { resolveFfmpeg } from '../deps/binaries'

/**
 * Video thumbnail cache: `<root>/.fsmgr-cache/cache/thumbs/<mediaId>.jpg`
 * (disposable, rebuilt on demand). Freshness is mtime-based against the media file, and
 * ffmpeg spawns are capped at a small concurrency so a fresh library doesn't
 * fork-bomb.
 *
 * The ffmpeg used here is whichever one the app resolves — the copy it
 * installed, a path the user set, or one on PATH — so updating it in settings
 * updates it for thumbnails too.
 */

const THUMB_WIDTH = 480
/** -q:v for mjpeg, 2 (best) – 31 (worst). */
const JPEG_QUALITY = '4'
/** Preferred grab point; falls back to the first frame for shorter files. */
const SEEK_SECONDS = 15
const MAX_CONCURRENT = 2
const FFMPEG_TIMEOUT_MS = 30_000

const inflight = new Map<string, Promise<string | null>>()

let active = 0
const waiters: (() => void)[] = []

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (active >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiters.push(resolve))
  }
  active++
  try {
    return await fn()
  } finally {
    active--
    waiters.shift()?.()
  }
}

function isVideoPath(path: string): boolean {
  const lower = path.toLowerCase()
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

function runFfmpeg(exe: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(exe, args, { windowsHide: true, stdio: 'ignore' })
    const timer = setTimeout(() => proc.kill(), FFMPEG_TIMEOUT_MS)
    proc.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}

/**
 * Get (extracting if stale/missing) a media item's thumbnail as a JPEG data
 * URL. Null for non-video files, missing files, or ffmpeg failures.
 */
export async function getThumbnailDataUrl(opts: {
  libraryRoot: string
  mediaId: string
  /** Media path relative to the library root (index.db `file_path`). */
  mediaRelPath: string
}): Promise<string | null> {
  if (!isVideoPath(opts.mediaRelPath)) return null
  const ffmpeg = await resolveFfmpeg()
  if (!ffmpeg) return null
  const mediaAbs = join(opts.libraryRoot, opts.mediaRelPath)
  const cachePath = join(
    opts.libraryRoot,
    LIBRARY_CACHE_DIR,
    'cache',
    'thumbs',
    `${opts.mediaId}.jpg`
  )

  const running = inflight.get(cachePath)
  if (running) return running
  const task = produce(ffmpeg, mediaAbs, cachePath).finally(() => inflight.delete(cachePath))
  inflight.set(cachePath, task)
  return task
}

async function produce(ffmpeg: string, mediaAbs: string, cachePath: string): Promise<string | null> {
  let mediaStat
  try {
    mediaStat = await stat(mediaAbs)
  } catch {
    return null // media file missing
  }

  try {
    const cached = await stat(cachePath)
    if (cached.mtimeMs >= mediaStat.mtimeMs) return toDataUrl(await readFile(cachePath))
  } catch {
    // cache miss — extract below
  }

  return withSlot(async () => {
    await mkdir(dirname(cachePath), { recursive: true })
    const tmp = `${cachePath}.tmp`
    const baseArgs = (seek: number): string[] => [
      '-y',
      ...(seek > 0 ? ['-ss', String(seek)] : []),
      '-i',
      mediaAbs,
      '-frames:v',
      '1',
      '-vf',
      `scale=${THUMB_WIDTH}:-2`,
      '-q:v',
      JPEG_QUALITY,
      '-f',
      'image2',
      tmp
    ]

    // Fast-seek to SEEK_SECONDS; a file shorter than that yields no frame,
    // so fall back to the first frame.
    let ok = (await runFfmpeg(ffmpeg, baseArgs(SEEK_SECONDS))) && (await hasContent(tmp))
    if (!ok) ok = (await runFfmpeg(ffmpeg, baseArgs(0))) && (await hasContent(tmp))
    if (!ok) {
      await unlink(tmp).catch(() => {})
      return null
    }
    try {
      await rename(tmp, cachePath)
    } catch (e) {
      await unlink(tmp).catch(() => {})
      throw e
    }
    return toDataUrl(await readFile(cachePath))
  })
}

async function hasContent(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0
  } catch {
    return false
  }
}

function toDataUrl(jpeg: Buffer): string {
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`
}
