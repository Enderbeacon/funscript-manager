import { VIDEO_SITES, type VideoSite } from '@shared/video-sites'
import type { DownloaderPlugin } from './base'
import { probeYtdlp, ytdlpPlugin } from './ytdlp'

/**
 * One yt-dlp plugin per row of the video site table. Each site is a plugin of
 * its own rather than another host in yt-dlp's list, so its jobs are labelled
 * with the site and queue under their own per-host limit.
 */
function videoSitePlugin(site: VideoSite): DownloaderPlugin {
  const parse = (url: string): URL | null => {
    try {
      const parsed = new URL(url)
      return site.host.test(parsed.hostname) && site.video.test(parsed.pathname) ? parsed : null
    } catch {
      return null
    }
  }

  return {
    ...ytdlpPlugin,
    id: site.id,

    match(url) {
      return parse(url) !== null
    },

    ownsHost(hostname) {
      return site.host.test(hostname)
    },

    /** The page's last path segment: the slug on most sites, else the id. */
    guessFileName(url) {
      const segments = parse(url)?.pathname.split('/').filter(Boolean) ?? []
      return segments[segments.length - 1]?.replace(/\.html?$/i, '') || site.id
    }
  }
}

/**
 * A post can carry several videos. yt-dlp downloads all of them for the post's
 * link, and a job has room for one file — so a post with more than one becomes
 * a job per video when it is added, each addressed as `/status/ID/video/N`,
 * which yt-dlp takes as that one video.
 *
 * Asking costs a yt-dlp run. When the answer does not come — no yt-dlp, no
 * network — the link stays one job and fails, if it is going to, at download
 * time with the reason attached.
 */
async function expandPost(url: string): Promise<string[]> {
  let base: string
  try {
    const parsed = new URL(url)
    if (/\/video\/\d+\/?$/i.test(parsed.pathname)) return [url]
    base = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`
  } catch {
    return [url]
  }
  try {
    const info = await probeYtdlp(url)
    const count = info._type === 'playlist' ? (info.entries?.length ?? 0) : 0
    if (count > 1) return Array.from({ length: count }, (_, i) => `${base}/video/${i + 1}`)
  } catch {
    // Fall through: one job, which reports whatever went wrong.
  }
  return [url]
}

export const videoSitePlugins: DownloaderPlugin[] = VIDEO_SITES.map((site) => {
  const plugin = videoSitePlugin(site)
  if (site.id !== 'twitter') return plugin
  return {
    ...plugin,
    expand: expandPost,
    /** `x-<post id>`, plus the video's number when it is one of several. */
    guessFileName(url) {
      const match = /\/status\/(\d+)(?:\/video\/(\d+))?/i.exec(url)
      if (!match) return 'x'
      return match[2] ? `x-${match[1]}-${match[2]}` : `x-${match[1]}`
    }
  }
})
