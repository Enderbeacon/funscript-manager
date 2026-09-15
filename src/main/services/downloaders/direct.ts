import { basename } from 'node:path'
import { httpDownloadToFile } from './http'
import { headStatus } from './link-check'
import type {
  DownloadInfo,
  DownloaderPlugin,
  DownloadResult,
  ProgressEvent
} from './base'

/**
 * Generic http(s) downloader — the fallback for any URL no specific plugin
 * claims, and how Payhip's one-time links are fetched once the user pastes one.
 *
 * It matches everything, so it must be registered last.
 */

/** Last path segment of a URL, percent-decoded; empty for bare hosts. */
export function fileNameFromUrl(url: string): string {
  try {
    const name = basename(new URL(url).pathname)
    return name ? decodeURIComponent(name) : ''
  } catch {
    return ''
  }
}

export const directPlugin: DownloaderPlugin = {
  id: 'direct',

  match(url) {
    return /^https?:\/\//i.test(url)
  },

  guessFileName(url) {
    return fileNameFromUrl(url) || 'download'
  },

  checkCost: 'cheap',

  /** resolve() never asks anyone anything, so the check has to do it itself. */
  check(url) {
    return headStatus(url, { headers: { Referer: new URL(url).origin + '/' } })
  },

  /**
   * Nothing to resolve: the URL the user gave is the direct link. Still
   * re-invoked on every resume/retry, which is exactly what a signed link
   * from Payhip or a CDN needs if the user pastes a fresh one.
   */
  async resolve(url) {
    return { url, filename: fileNameFromUrl(url) || 'download' }
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
      // Some hosts reject requests without a browser-ish Referer/UA pair.
      headers: { Referer: new URL(info.url).origin + '/' }
    })
    return {
      filePath: targetPath,
      sizeBytes: res.sizeBytes,
      ...(res.serverFileName ? { fileName: res.serverFileName } : {})
    }
  }
}
