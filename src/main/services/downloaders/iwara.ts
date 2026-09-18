import type { DownloaderPlugin } from './base'
import { ytdlpPlugin } from './ytdlp'

/**
 * Iwara videos, downloaded by yt-dlp.
 *
 * Checked on 2026-09-17 before being written: Iwara's API sits behind a
 * Cloudflare check that turns Node's `fetch` away while it lets yt-dlp through,
 * and yt-dlp lists the resolutions (360p, 540p, Source) and downloads them
 * without an account for public videos.
 *
 * Only a video page is claimed. Iwara links in posts are just as often the
 * uploader's profile or video list, and yt-dlp would take one of those as an
 * instruction to download every video on the channel — so those stay links to
 * open in a browser.
 *
 * A plugin of its own rather than another host in yt-dlp's list, so Iwara jobs
 * are labelled as Iwara and queue under their own per-host limit.
 */

const VIDEO_URL = /^https?:\/\/(?:www\.)?iwara\.tv\/video\/([\w-]+)/i

export const iwaraPlugin: DownloaderPlugin = {
  ...ytdlpPlugin,
  id: 'iwara',

  match(url) {
    return VIDEO_URL.test(url)
  },

  ownsHost(hostname) {
    return /^(?:www\.)?iwara\.tv$/i.test(hostname)
  },

  guessFileName(url) {
    return VIDEO_URL.exec(url)?.[1] ?? 'iwara'
  }
}
