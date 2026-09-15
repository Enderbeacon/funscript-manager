import { createWriteStream } from 'node:fs'
import { mkdir, stat, truncate } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { throttleStage } from '../net/throttle'
import {
  DirectLinkExpiredError,
  HttpStatusError,
  PermanentError,
  type ProgressEvent
} from './base'

/**
 * Shared HTTP body → file downloader with Range resume. Every direct-link
 * plugin funnels through here so resume, expiry detection and progress
 * reporting behave identically across sources.
 */

export interface HttpDownloadOptions {
  url: string
  /** Partial file; its current size is the resume offset. */
  partPath: string
  headers?: Record<string, string>
  signal: AbortSignal
  onProgress: (p: ProgressEvent) => void
  /**
   * Fail with this reason code when the host answers 200-with-a-web-page
   * instead of the file. Several sources do exactly that: gofile serves an
   * HTML page when the account cookie is missing, and a deleted Dropbox share
   * answers 200 with "File Deleted". Without this the queue would happily
   * write the page to disk and call the job done.
   */
  htmlIsError?: string
  /**
   * Leave the transfer unpaced. Only for the app updating its own binaries:
   * that is a foreground install the user is waiting on, not queue traffic.
   */
  noRateLimit?: boolean
  /**
   * Fetch to use instead of Node's. Electron's `net.fetch` runs on the app's
   * own session, so a source that only serves signed-in users (forum
   * attachments) carries the cookies the login window picked up.
   */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>
}

/** `text/html`, `application/xhtml+xml` — anything that is a page, not a file. */
function looksLikeHtml(contentType: string | null): boolean {
  if (!contentType) return false
  return /^\s*(text\/html|application\/xhtml)/i.test(contentType)
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/** `attachment; filename="a b.mp4"` → `a b.mp4`; RFC 5987 form wins when present. */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null
  const star = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(header)
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim())
    } catch {
      /* fall through to the plain form */
    }
  }
  const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i.exec(header)
  const value = plain?.[1] ?? plain?.[2]
  return value ? value.trim() : null
}

export interface HttpDownloadResult {
  sizeBytes: number
  /** Filename the server advertised, if any. */
  serverFileName: string | null
}

/**
 * Download `url` into `partPath`, appending to whatever is already there.
 *
 * A server that ignores the Range header (200 instead of 206) restarts the
 * file from zero — silently appending to the old bytes would corrupt it.
 */
export async function httpDownloadToFile(opts: HttpDownloadOptions): Promise<HttpDownloadResult> {
  const { url, partPath, signal, onProgress } = opts
  await mkdir(dirname(partPath), { recursive: true })

  let offset = await sizeOf(partPath)
  const headers: Record<string, string> = { ...opts.headers }
  if (offset > 0) headers.Range = `bytes=${offset}-`

  const res = await (opts.fetchImpl ?? fetch)(url, { headers, signal, redirect: 'follow' })

  if (res.status === 403 || res.status === 410) {
    // Expiring signature, not a hard failure: the queue re-resolves and retries.
    throw new DirectLinkExpiredError(res.status)
  }
  if (!res.ok) throw new HttpStatusError(res.status)

  if (opts.htmlIsError && looksLikeHtml(res.headers.get('content-type'))) {
    await res.body?.cancel().catch(() => {})
    throw new PermanentError(opts.htmlIsError)
  }

  let append = true
  if (offset > 0 && res.status !== 206) {
    // Range ignored — start over rather than concatenate two copies.
    await truncate(partPath, 0).catch(() => {})
    offset = 0
    append = false
  }

  const contentLength = Number(res.headers.get('content-length') ?? '')
  const totalBytes = Number.isFinite(contentLength) && contentLength > 0
    ? offset + contentLength
    : undefined

  let downloaded = offset
  let windowStart = Date.now()
  let windowBytes = 0
  const report = (): void => {
    const elapsed = (Date.now() - windowStart) / 1000
    const speed = elapsed > 0 ? windowBytes / elapsed : 0
    onProgress({
      bytesDownloaded: downloaded,
      totalBytes,
      speedBytesPerSec: speed,
      etaSec: totalBytes && speed > 0 ? Math.max(0, (totalBytes - downloaded) / speed) : undefined
    })
    if (elapsed >= 1) {
      windowStart = Date.now()
      windowBytes = 0
    }
  }

  if (!res.body) throw new HttpStatusError(res.status)
  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
  source.on('data', (chunk: Buffer) => {
    downloaded += chunk.length
    windowBytes += chunk.length
    report()
  })

  // No signal on the write side: an aborted fetch already destroys the source,
  // and letting the sink close normally keeps the partial bytes on disk.
  const sink = createWriteStream(partPath, { flags: append ? 'a' : 'w' })
  const pacer = opts.noRateLimit ? null : await throttleStage()
  await (pacer ? pipeline(source, pacer, sink) : pipeline(source, sink))

  return {
    sizeBytes: await sizeOf(partPath),
    serverFileName: filenameFromDisposition(res.headers.get('content-disposition'))
  }
}
