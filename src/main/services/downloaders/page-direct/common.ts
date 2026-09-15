import { net } from 'electron'
import { byPreference, type QualityPreference } from '@shared/quality'
import { getSettings } from '../../config/config-service'
import { httpDownloadToFile } from '../http'
import { headStatus } from '../link-check'
import {
  HttpStatusError,
  PermanentError,
  type DownloadInfo,
  type DownloaderPlugin,
  type DownloadResult,
  type ProgressEvent
} from '../base'

/**
 * Shared shape for the page-direct parsers: sites whose video page lists its
 * own file links, read directly instead of through yt-dlp.
 *
 * All three sites work the same way: the video page lists a direct file URL per
 * resolution, so the parser's whole job is to return those and let the shared
 * HTTP downloader do the transfer. That keeps Range resume, expiry handling and
 * progress reporting identical to every other direct-link source.
 *
 * Every link these sites hand out carries a signature, an expiry or both
 * (eporner's even embeds the requesting IP), so nothing is persisted: the queue
 * stores the page URL and `resolve()` runs again on every resume and retry.
 */

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/140.0.0.0 Safari/537.36'

/** One resolution the page offers. `height` is what the quality preference sorts on. */
export interface VideoOffer {
  height: number
  /** As shown on the page ("1080p"), for logs and error text. */
  label: string
  url: string
  /**
   * The name the site gives this particular file, when it names them per
   * resolution (rule34video puts it in the link). Beats the page title, which
   * cannot know which resolution the preference ended up picking.
   */
  fileName?: string
}

export interface ParsedPage {
  offers: VideoOffer[]
  /** File name stem, without extension. */
  title: string
  /** Extension including the dot; defaults to `.mp4`. */
  ext?: string
}

/**
 * The page did not look the way we expect — a layout change, or a wall in front
 * of it. Distinct from a dead video so that only this case falls back to yt-dlp:
 * for a removed video both paths fail, and trying twice just makes the user wait.
 */
export class PageParseError extends Error {
  constructor(readonly reason: string) {
    super(reason)
    this.name = 'PageParseError'
  }
}

/**
 * Extra hostnames a plugin should claim, from an env var — the same test seam
 * `FSMGR_YTDLP_HOSTS` gives yt-dlp. It lets a smoke point a source at a stub
 * server on 127.0.0.1 instead of the live site.
 */
export function extraHosts(envVar: string): string[] {
  return (process.env[envVar] ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * Fetch through Electron's own network stack rather than Node's.
 *
 * This is not a style choice. Measured on 2026-07-27: hanime1 sits behind
 * Cloudflare bot management, and from inside this very process Node's `fetch`
 * gets a flat 403 while `net.fetch` gets a 200 — same URL, same headers, same
 * machine. Chromium presents a real browser TLS fingerprint; undici does not,
 * and no combination of headers made up the difference.
 *
 * Only page and API reads go through here. File transfers stay on Node's fetch,
 * where the streaming and Range handling in `httpDownloadToFile` already live,
 * and where no CDN has objected.
 */
export function siteFetch(url: string, init?: Parameters<typeof net.fetch>[1]): Promise<Response> {
  return net.fetch(url, init)
}

export async function fetchPage(url: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await siteFetch(url, {
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      ...headers
    },
    redirect: 'follow'
  })
  if (!res.ok) throw new PageParseError(`page_http_${res.status}`)
  return res.text()
}

/**
 * Pick a resolution for the user's preference. The preference is a ceiling, not
 * a filter: when every offer sits above it (a 4K-only upload) the closest one
 * still wins, because refusing to download is never the better answer.
 */
export function pickOffer(offers: VideoOffer[], preferred: QualityPreference): VideoOffer {
  const ordered = byPreference(offers, (o) => o.height, preferred)
  const choice = ordered[0]
  if (!choice) throw new PageParseError('no_offers')
  return choice
}

/** Strip a site's boilerplate suffix and anything Windows will not accept. */
export function cleanTitle(raw: string, stripSuffix?: RegExp): string {
  let title = raw
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
  if (stripSuffix) title = title.replace(stripSuffix, '')
  return title.replace(/\s+/g, ' ').trim() || 'video'
}

export interface PageDirectOptions {
  id: string
  hosts: RegExp[]
  parse: (pageUrl: string) => Promise<ParsedPage>
  /** Referer for the file request; several of these CDNs check it. */
  referer: (pageUrl: string) => string
  /**
   * Reason code the job fails with when this source cannot deliver — the page
   * would not parse and there is no fallback, or the "file" URL served a web
   * page. One code for both: the user's move is the same either way, so the
   * specific cause belongs in the log, not in the UI.
   */
  unavailableReason: string
  /**
   * Used when the page cannot be parsed. eporner and rule34video have working
   * yt-dlp extractors, so the two paths cover each other;
   * hanime1 has none and fails visibly instead.
   */
  fallback?: DownloaderPlugin
  /** Env var naming extra hostnames to claim; see `extraHosts`. */
  hostsEnv?: string
}

/** True once resolve() decided this job goes through the fallback plugin. */
const VIA_FALLBACK = 'viaFallback'

export function pageDirectPlugin(opts: PageDirectOptions): DownloaderPlugin {
  const plugin: DownloaderPlugin = {
    id: opts.id,

    match(url) {
      try {
        const { hostname } = new URL(url)
        if (opts.hosts.some((h) => h.test(hostname))) return true
        return opts.hostsEnv ? extraHosts(opts.hostsEnv).includes(hostname.toLowerCase()) : false
      } catch {
        return false
      }
    },

    guessFileName(url) {
      try {
        const segments = new URL(url).pathname.split('/').filter(Boolean)
        return segments[segments.length - 1] || opts.id
      } catch {
        return opts.id
      }
    },

    /**
     * Checking one of these means parsing the page — sometimes behind a bot
     * wall, sometimes in a hidden window, sometimes by starting yt-dlp. Far too
     * much to spend on a post the user is only looking at, so it waits to be
     * asked for.
     */
    checkCost: 'slow',

    /**
     * Ask the page first. resolve() folds "this video was removed" into the
     * same "cannot read this page" as a site redesign, because for a download
     * they lead to the same place — but for a check they are opposite answers,
     * and a 404 from the page settles it without parsing anything.
     */
    async check(url) {
      const page = await headStatus(url, { headers: { 'User-Agent': BROWSER_UA } })
      if (page === 'gone') return 'gone'
      try {
        await plugin.resolve(url)
        return 'alive'
      } catch {
        // Parsed nothing and the page is still there: a wall, a redesign, or a
        // bot check. None of that means the video is gone.
        return 'unknown'
      }
    },

    async resolve(url) {
      try {
        const page = await opts.parse(url)
        const settings = await getSettings()
        const offer = pickOffer(page.offers, settings.download.preferredQuality)
        return {
          url: offer.url,
          filename: offer.fileName ?? `${page.title}${page.ext ?? '.mp4'}`,
          context: { [VIA_FALLBACK]: false, quality: offer.label }
        }
      } catch (e) {
        if (!(e instanceof PageParseError)) throw e
        // A server-side wobble is worth the queue's normal backoff; a changed
        // page is not, and neither is a wall.
        const status = Number(/^page_http_(\d{3})$/.exec(e.reason)?.[1] ?? 0)
        if (status >= 500) throw new HttpStatusError(status)

        if (!opts.fallback) {
          console.warn(`[${opts.id}] page parse failed: ${e.reason}`)
          throw new PermanentError(opts.unavailableReason)
        }
        // The page changed shape. Hand the *page* URL to yt-dlp — it does its
        // own extraction, so it needs the original address, not our parse.
        console.warn(`[${opts.id}] page parse failed (${e.reason}); falling back to yt-dlp`)
        const info = await opts.fallback.resolve(url)
        return { ...info, context: { ...info.context, [VIA_FALLBACK]: true } }
      }
    },

    async download(
      info: DownloadInfo,
      targetPath: string,
      onProgress: (p: ProgressEvent) => void,
      signal: AbortSignal
    ): Promise<DownloadResult> {
      if (info.context?.[VIA_FALLBACK] === true) {
        if (!opts.fallback) throw new PermanentError(opts.unavailableReason)
        return opts.fallback.download(info, targetPath, onProgress, signal)
      }
      const res = await httpDownloadToFile({
        url: info.url,
        partPath: targetPath,
        signal,
        onProgress,
        headers: { Referer: opts.referer(info.url), 'User-Agent': BROWSER_UA },
        htmlIsError: opts.unavailableReason
      })
      // The page's own title beats a CDN path segment, so resolve()'s name
      // stands unless the server actually advertised one.
      return {
        filePath: targetPath,
        sizeBytes: res.sizeBytes,
        ...(res.serverFileName ? { fileName: res.serverFileName } : {})
      }
    },

    ...(opts.fallback?.cleanup
      ? { cleanup: (partPath: string) => opts.fallback!.cleanup!(partPath) }
      : {})
  }
  return plugin
}
