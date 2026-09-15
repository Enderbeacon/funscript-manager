import { ytdlpPlugin } from '../ytdlp'
import { fetchViaWindow } from './challenge-window'
import {
  BROWSER_UA,
  PageParseError,
  cleanTitle,
  pageDirectPlugin,
  type ParsedPage,
  type VideoOffer
} from './common'

/**
 * spankbang. Same shape as the other page-direct sources once the page
 * is in hand — the difference is getting it.
 *
 * The site is behind Cloudflare's JS challenge, and neither Node's `fetch` nor
 * Electron's `net.fetch` gets past it, even after a real window has solved it and
 * left `cf_clearance` in the jar. So the page is read out of a hidden window
 * (see challenge-window.ts). Only the *page* needs that; the file links are plain
 * signed URLs that Node's fetch downloads with a 206 like any other CDN.
 *
 * The page carries a `stream_data = {…}` object, one array per resolution:
 *
 *   {'240p': ['https://vdownload-47.sb-cd.com/…-240p.mp4?secure=SIG,EXPIRY&…'],
 *    '320p': [], '480p': [...], '720p': [...], '1080p': [], '4k': [],
 *    'm3u8': [...], 'main': [...], 'length': 511, …}
 *
 * Resolutions the upload does not have are present but empty, so an entry only
 * counts when it actually holds a URL. It is JavaScript, not JSON (single
 * quotes), and it is read with a regex rather than evaluated — this is a page we
 * do not control.
 */

const BASE = process.env.FSMGR_SPANKBANG_BASE || 'https://spankbang.com'

/** `/a4xao/video/slug`, `/a4xao/embed/`, `/a4xao/playlist/…` — the id comes first. */
const VIDEO_PATH = /^\/([0-9a-z]{4,12})\/(?:video|embed|play|v)\b/i

/** `'720p': ['https://…']` — captures the label and the array body. */
const QUALITY_ENTRY = /['"](\d{3,4}p|4k)['"]\s*:\s*\[([^\]]*)\]/gi

const FIRST_URL = /['"](https?:\/\/[^'"]+)['"]/

function heightOf(label: string): number {
  if (/^4k$/i.test(label)) return 2160
  return Number(label.replace(/p$/i, '')) || 0
}

function videoId(pageUrl: string): string {
  try {
    const id = VIDEO_PATH.exec(new URL(pageUrl).pathname)?.[1]
    if (id) return id
  } catch {
    /* fall through */
  }
  throw new PageParseError('no_video_id')
}

/**
 * An `/embed/` address is not where `stream_data` lives; the watch page is. The
 * slug does not matter — the id is what the site resolves on.
 */
function watchUrl(pageUrl: string, id: string): string {
  try {
    const url = new URL(pageUrl)
    if (!/\/embed\b/i.test(url.pathname)) return pageUrl
    return `${url.origin}/${id}/video/x`
  } catch {
    return `${BASE}/${id}/video/x`
  }
}

async function parse(pageUrl: string): Promise<ParsedPage> {
  const id = videoId(pageUrl)
  // Always through the window, including in smokes: it is the only way this
  // source can be read, so it is the path worth testing.
  const html = await fetchViaWindow(watchUrl(pageUrl, id), BROWSER_UA)

  const block = /stream_data\s*=\s*\{([\s\S]*?)\}\s*;/.exec(html)?.[1]
  if (!block) throw new PageParseError('no_stream_data')

  const offers: VideoOffer[] = []
  for (let m = QUALITY_ENTRY.exec(block); m !== null; m = QUALITY_ENTRY.exec(block)) {
    const label = m[1]!
    const first = FIRST_URL.exec(m[2]!)?.[1]
    if (!first) continue // the resolution exists as a key but this upload has none
    const height = heightOf(label)
    if (height > 0) offers.push({ height, label, url: first })
  }
  QUALITY_ENTRY.lastIndex = 0
  if (offers.length === 0) throw new PageParseError('no_mp4_sources')

  // "<name>: Porn - SpankBang" — both halves of the suffix are the site's own.
  const title = cleanTitle(
    /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? id,
    /\s*:?\s*(Porn\s*)?[-–]\s*SpankBang\s*$/i
  )

  return { offers, title, ext: '.mp4' }
}

export const spankbangPlugin = pageDirectPlugin({
  id: 'spankbang',
  hosts: [/(^|\.)spankbang\.com$/i, /(^|\.)spankbang\.party$/i],
  hostsEnv: 'FSMGR_SPANKBANG_HOSTS',
  parse,
  referer: () => `${BASE}/`,
  unavailableReason: 'spankbang_unavailable',
  // yt-dlp has an extractor for this site. It faces the same challenge, so it is
  // not a strong net — but it costs nothing.
  fallback: ytdlpPlugin
})
