import { httpDownloadToFile } from '../http'
import { headStatus } from '../link-check'
import { extraHosts } from '../page-direct/common'
import {
  PermanentError,
  type DownloadInfo,
  type DownloaderPlugin,
  type DownloadResult,
  type ProgressEvent
} from '../base'

/**
 * Dropbox public share links.
 *
 * Verified against a live share (2026-07-27): the bytes come from
 * `dl.dropboxusercontent.com` with `dl=1`, which answers 206 for a Range and
 * sets Content-Disposition. Two ways to get this wrong:
 *
 * - `www.dropbox.com/…?dl=1` answers **200 with a web page**, not the file.
 * - A deleted file on `www` also answers 200, titled "File Deleted"; on the
 *   `dl.` host the same link is a clean 404. So the host swap is not just a
 *   shortcut, it is what makes a dead link look dead.
 *
 * Folder shares (`/scl/fo/…`) are left alone: they download as a generated zip
 * whose contents nobody chose, which is not what the post's file list means.
 */

/**
 * The origin that actually serves bytes. FSMGR_DROPBOX_HOST replaces it for
 * smokes and may carry its own scheme, so a plain-http stub works too.
 */
const DIRECT_ORIGIN = (() => {
  const configured = process.env.FSMGR_DROPBOX_HOST || 'dl.dropboxusercontent.com'
  return /^https?:\/\//i.test(configured) ? configured : `https://${configured}`
})()

const FILE_SHARE = /dropbox\.com\/(?:s|scl\/fi)\//i
const FOLDER_SHARE = /dropbox\.com\/(?:sh|scl\/fo)\//i

/** Share URL → the host and query that actually serve bytes. */
export function directUrl(share: string): string {
  const url = new URL(share)
  const direct = new URL(DIRECT_ORIGIN)
  url.protocol = direct.protocol
  url.host = direct.host
  url.searchParams.set('dl', '1')
  return url.toString()
}

export const dropboxPlugin: DownloaderPlugin = {
  id: 'dropbox',

  match(url) {
    if (FILE_SHARE.test(url) || FOLDER_SHARE.test(url)) return true
    try {
      return extraHosts('FSMGR_DROPBOX_HOSTS').includes(new URL(url).hostname.toLowerCase())
    } catch {
      return false
    }
  },

  guessFileName(url) {
    try {
      // `/scl/fi/<id>/<name>?…` — the name is the last non-query segment.
      const name = new URL(url).pathname.split('/').filter(Boolean).pop() ?? ''
      return decodeURIComponent(name) || 'dropbox'
    } catch {
      return 'dropbox'
    }
  },

  checkCost: 'cheap',

  /**
   * Resolving a Dropbox link is pure string work, so the check asks the `dl.`
   * host directly — the one place where a deleted file is a plain 404 instead
   * of a 200-with-a-page. A folder share is not answerable this way and is left
   * unknown rather than called dead.
   */
  async check(url) {
    if (FOLDER_SHARE.test(url)) return 'unknown'
    return headStatus(directUrl(url))
  },

  async resolve(url) {
    if (FOLDER_SHARE.test(url)) throw new PermanentError('dropbox_folder')
    return { url: directUrl(url), filename: dropboxPlugin.guessFileName!(url) }
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
      htmlIsError: 'dropbox_gone'
    })
    return {
      filePath: targetPath,
      sizeBytes: res.sizeBytes,
      ...(res.serverFileName ? { fileName: res.serverFileName } : {})
    }
  }
}
