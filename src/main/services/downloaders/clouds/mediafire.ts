import { httpDownloadToFile } from '../http'
import { BROWSER_UA, extraHosts, fetchPage, siteFetch } from '../page-direct/common'
import {
  PermanentError,
  type DownloadInfo,
  type DownloaderPlugin,
  type DownloadResult,
  type ProgressEvent
} from '../base'

/**
 * MediaFire public file links.
 *
 * Verified live (2026-07-27). Two sources of truth, used for different things:
 *
 * - `GET /api/1.5/file/get_info.php?quick_key=…` — a documented endpoint that
 *   gives the real name and size without scraping. Used for the metadata the UI
 *   shows before the transfer starts.
 * - The file page — the only place the actual `download###.mediafire.com` link
 *   appears. That link is per-session, so it is resolved just in time like every
 *   other expiring direct link.
 *
 * The CDN answered 206 for a Range and set Content-Disposition.
 */

const API_BASE = process.env.FSMGR_MEDIAFIRE_API || 'https://www.mediafire.com/api/1.5'

/**
 * Host and path are checked apart from each other: `match` gates on the host
 * (which the smoke seam can extend), and the key comes from the path. Folding
 * both into one pattern is what made a stub URL unrecognisable.
 */
const HOST = /(^|\.)mediafire\.com$/i

/** `/file/<quickkey>/<name>/file`, `/file/<quickkey>`, `/file_premium/<key>`. */
const FILE_PATH = /\/(?:file|file_premium|download)\/(\w{11,15})/i
const FOLDER_PATH = /\/folder\//i

function isMediafireHost(url: string): boolean {
  try {
    const { hostname } = new URL(url)
    return HOST.test(hostname) || extraHosts('FSMGR_MEDIAFIRE_HOSTS').includes(hostname.toLowerCase())
  } catch {
    return false
  }
}

/**
 * The download link the file page carries. FSMGR_MEDIAFIRE_DIRECT replaces the
 * pattern so a smoke can point it at a stub CDN instead of the real one.
 */
const DIRECT_LINK = process.env.FSMGR_MEDIAFIRE_DIRECT
  ? new RegExp(process.env.FSMGR_MEDIAFIRE_DIRECT, 'i')
  : /https?:\/\/download\d*\.mediafire\.com\/[^"'\s>]+/i

interface FileInfo {
  filename?: string
  size?: string
  ready?: string
}

function quickKey(url: string): string {
  const key = FILE_PATH.exec(new URL(url).pathname)?.[1]
  if (!key) throw new PermanentError('mediafire_bad_link')
  return key
}

async function fileInfo(key: string): Promise<FileInfo | null> {
  try {
    const res = await siteFetch(
      `${API_BASE}/file/get_info.php?quick_key=${encodeURIComponent(key)}&response_format=json`,
      { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' } }
    )
    if (!res.ok) return null
    const body = (await res.json()) as { response?: { file_info?: FileInfo } }
    return body.response?.file_info ?? null
  } catch {
    // Metadata is a nicety; the page still carries the name in its disposition.
    return null
  }
}

export const mediafirePlugin: DownloaderPlugin = {
  id: 'mediafire',

  match(url) {
    if (!isMediafireHost(url)) return false
    const path = new URL(url).pathname
    return FILE_PATH.test(path) || FOLDER_PATH.test(path)
  },

  guessFileName(url) {
    // `/file/<key>/<name>/file` — the name sits between the key and "file".
    const parts = url.split('?')[0]!.split('/').filter(Boolean)
    const tail = parts[parts.length - 1] === 'file' ? parts[parts.length - 2] : undefined
    if (tail && !/^\w{11,15}$/.test(tail)) {
      try {
        return decodeURIComponent(decodeURIComponent(tail))
      } catch {
        return tail
      }
    }
    return 'mediafire'
  },

  /** resolve() reads the file page; a taken-down file has no download offer. */
  checkCost: 'cheap',

  async resolve(url) {
    if (FOLDER_PATH.test(new URL(url).pathname)) throw new PermanentError('mediafire_folder')
    const key = quickKey(url)
    // Referred by the site itself. Must be same-origin as the request: a fixed
    // https referer in front of an http request is a mixed-content pattern that
    // Chromium's stack refuses outright (ERR_BLOCKED_BY_CLIENT).
    const origin = new URL(url).origin
    const html = await fetchPage(url, { Referer: `${origin}/` })
    const direct = DIRECT_LINK.exec(html)?.[0]
    if (!direct) {
      // The page renders but has no offer: taken down, or behind a password.
      throw new PermanentError(
        /password/i.test(html) ? 'mediafire_password' : 'mediafire_gone'
      )
    }
    const info = await fileInfo(key)
    const size = Number(info?.size ?? NaN)
    return {
      url: direct,
      filename: info?.filename || mediafirePlugin.guessFileName!(url),
      ...(Number.isFinite(size) && size > 0 ? { sizeBytes: size } : {}),
      context: { pageUrl: url }
    }
  },

  async download(
    info: DownloadInfo,
    targetPath: string,
    onProgress: (p: ProgressEvent) => void,
    signal: AbortSignal
  ): Promise<DownloadResult> {
    const res = await httpDownloadToFile({
      url: info.url,
      partPath: targetPath,
      signal,
      onProgress,
      headers: {
        'User-Agent': BROWSER_UA,
        Referer: String(info.context?.pageUrl ?? `${new URL(info.url).origin}/`)
      },
      htmlIsError: 'mediafire_gone'
    })
    return {
      filePath: targetPath,
      sizeBytes: res.sizeBytes,
      ...(res.serverFileName ? { fileName: res.serverFileName } : {})
    }
  }
}
