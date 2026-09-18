import { resolveYtdlp } from '../deps/binaries'
import {
  PermanentError,
  type DownloadInfo,
  type DownloaderPlugin,
  type DownloadResult,
  type ProgressEvent
} from './base'
import { fileNameFromUrl } from './direct'
import { httpDownloadToFile } from './http'
import { ytdlpPlugin } from './ytdlp'

/**
 * A page on a site nothing else knows — pasted by hand, since the forum
 * scanner never offers one.
 *
 * yt-dlp reads far more sites than have a plugin here, and its generic reader
 * finds the player on plenty it has no name for, so it is asked first. Only
 * when it has nothing to say is the address fetched as a file — and if that
 * turns out to be a web page, the job fails as unsupported rather than
 * saving the page as though it were the download.
 *
 * Addresses that end in a file name skip all this and go to the plain file
 * downloader, which is registered after this one.
 */

/** Extensions that name a page, not a file. */
const PAGE_EXTENSIONS = /^(?:html?|shtml|php\d?|aspx?|jsp|cgi)$/i

function looksLikeFile(url: URL): boolean {
  const last = url.pathname.split('/').pop() ?? ''
  const dot = last.lastIndexOf('.')
  return dot > 0 && !PAGE_EXTENSIONS.test(last.slice(dot + 1))
}

type Route = 'ytdlp' | 'file'

function asFile(url: string): DownloadInfo {
  return { url, filename: fileNameFromUrl(url) || 'download', context: { route: 'file' satisfies Route } }
}

export const webPlugin: DownloaderPlugin = {
  id: 'web',

  match(url) {
    try {
      const parsed = new URL(url)
      return /^https?:$/.test(parsed.protocol) && !looksLikeFile(parsed)
    } catch {
      return false
    }
  },

  guessFileName(url) {
    try {
      const parsed = new URL(url)
      return parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname
    } catch {
      return 'download'
    }
  },

  checkCost: 'slow',

  async resolve(url) {
    if (!(await resolveYtdlp())) return asFile(url)
    try {
      const info = await ytdlpPlugin.resolve(url)
      return { ...info, context: { route: 'ytdlp' satisfies Route } }
    } catch (e) {
      if (e instanceof PermanentError && e.reason === 'ytdlp_unsupported') return asFile(url)
      throw e
    }
  },

  async download(
    info: DownloadInfo,
    targetPath: string,
    onProgress: (p: ProgressEvent) => void,
    signal: AbortSignal
  ): Promise<DownloadResult> {
    if (info.context?.route === 'ytdlp') return ytdlpPlugin.download(info, targetPath, onProgress, signal)
    const res = await httpDownloadToFile({
      url: info.url,
      partPath: targetPath,
      signal,
      onProgress,
      headers: { Referer: new URL(info.url).origin + '/' },
      htmlIsError: 'ytdlp_unsupported'
    })
    return {
      filePath: targetPath,
      sizeBytes: res.sizeBytes,
      ...(res.serverFileName ? { fileName: res.serverFileName } : {})
    }
  },

  async cleanup(partPath) {
    await ytdlpPlugin.cleanup?.(partPath)
  }
}
