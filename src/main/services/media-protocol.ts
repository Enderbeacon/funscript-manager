import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import { findByAbsPath, getMediaLocation } from './library/library-manager'

/**
 * `fsmgr-media://` — a loopback streaming scheme so the renderer can play a
 * media file inline (hover preview on cards, auto-preview in the detail panel)
 * without exposing arbitrary file:// access. URLs carry only ids:
 *   fsmgr-media://media/?lib=<libraryId>&id=<mediaId>
 * The handler resolves them to an absolute path via the library index and
 * streams the bytes with HTTP range support (so <video> can seek/stream large
 * files instead of buffering the whole thing). The scheme is already allowed in
 * the renderer CSP (img-src/media-src). Everything degrades to a 404 so a bad
 * id just falls back to the static thumbnail.
 */

export const MEDIA_SCHEME = 'fsmgr-media'

/** Extensions Chromium can actually decode; others get no inline preview. */
const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg'
}

/** Must run before app `ready` (privileged-scheme registration is one-shot). */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true }
    }
  ])
}

/**
 * Two ways to name a file, both resolved through the library index.
 *
 * `media/?lib=&id=` is how the pages address a library entry they are already
 * holding. `file/?p=` is how the built-in player addresses one, because the
 * player port speaks paths — every player is told a path, and this is the only
 * place that has to know what a library is.
 *
 * Neither form opens a file the index does not know: a path outside every
 * registered library resolves to null and comes back as a 404, so this stays a
 * view of the library rather than general file access.
 */
function resolvePath(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    const path = url.searchParams.get('p')
    if (path) {
      const found = findByAbsPath(path)
      return found ? join(found.libraryRoot, found.mediaRelPath) : null
    }
    const libraryId = url.searchParams.get('lib')
    const mediaId = url.searchParams.get('id')
    if (!libraryId || !mediaId) return null
    const loc = getMediaLocation(libraryId, mediaId)
    return join(loc.libraryRoot, loc.mediaRelPath)
  } catch {
    // Library not started / media not found → no preview.
    return null
  }
}

function toWebStream(abs: string, start?: number, end?: number): ReadableStream {
  const node = createReadStream(abs, start === undefined ? {} : { start, end })
  return Readable.toWeb(node) as unknown as ReadableStream
}

/** Register the handler; call once after app `ready`. */
export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const abs = resolvePath(request.url)
    if (!abs) return new Response(null, { status: 404 })

    let size: number
    try {
      size = (await stat(abs)).size
    } catch {
      return new Response(null, { status: 404 })
    }

    const type = MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream'
    const range = request.headers.get('range')
    const match = range ? /bytes=(\d*)-(\d*)/.exec(range) : null

    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0
      const end = match[2] ? Math.min(parseInt(match[2], 10), size - 1) : size - 1
      if (Number.isNaN(start) || start > end || start >= size) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      }
      return new Response(toWebStream(abs, start, end), {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes'
        }
      })
    }

    return new Response(toWebStream(abs), {
      status: 200,
      headers: {
        'Content-Type': type,
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes'
      }
    })
  })
}
