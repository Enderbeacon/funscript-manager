import type { DownloaderPlugin } from './base'
import { ytdlpPlugin } from './ytdlp'

/**
 * XVIDEOS and XNXX videos, downloaded by yt-dlp.
 *
 * The two sites share one player, and both pages carry the same three links:
 * a 240p and a 360p mp4, and an HLS playlist. Checked on 2026-09-17 before
 * being written: the mp4 links stop at 360p on every upload, and 480p, 720p and
 * 1080p exist only as HLS variants. yt-dlp lists those variants and joins the
 * segments into an mp4 with sound, so it gets the resolution the quality
 * preference asks for, where reading the mp4 links off the page never could.
 *
 * Only video pages are claimed. A profile, channel or search page is not a
 * video, and yt-dlp turns them away anyway — so those stay links to open.
 *
 * One plugin per site rather than more hosts in yt-dlp's list, so jobs are
 * labelled with the site they came from and queue under its own per-host limit.
 */

/**
 * `/video.otlkubv2c35/slug` (current ids), `/video4588838/slug` (older numeric
 * ids) and `/embedframe/4588838`, on xvideos.com and its language subdomains,
 * xvideos2.com and xvideos.es.
 */
const XVIDEOS_HOST = /^(?:[^.]+\.)?(?:xvideos2?\.com|xvideos\.es)$/i
const XVIDEOS_PATH = /^\/(?:video(?:\.[0-9a-z]+|\d+)|embedframe\/[0-9a-z]+)(?:\/|$)/i

/** `/video-17t6t955/slug` (current ids) and `/video1135332/slug` (older ones). */
const XNXX_HOST = /^(?:[^.]+\.)?xnxx3?\.com$/i
const XNXX_PATH = /^\/video(?:-[0-9a-z]+|\d+)(?:\/|$)/i

function videoPlugin(id: string, host: RegExp, path: RegExp): DownloaderPlugin {
  const parse = (url: string): URL | null => {
    try {
      const parsed = new URL(url)
      return host.test(parsed.hostname) && path.test(parsed.pathname) ? parsed : null
    } catch {
      return null
    }
  }

  return {
    ...ytdlpPlugin,
    id,

    match(url) {
      return parse(url) !== null
    },

    ownsHost(hostname) {
      return host.test(hostname)
    },

    /**
     * The slug, which is the title in lower case; else the id. The slug is the
     * last segment rather than the one after the id, because links copied off
     * a listing put more in between (`/video.x/sfw-straight/0/slug`).
     */
    guessFileName(url) {
      const segments = parse(url)?.pathname.split('/').filter(Boolean) ?? []
      return segments[segments.length - 1] || id
    }
  }
}

export const xvideosPlugin = videoPlugin('xvideos', XVIDEOS_HOST, XVIDEOS_PATH)
export const xnxxPlugin = videoPlugin('xnxx', XNXX_HOST, XNXX_PATH)
