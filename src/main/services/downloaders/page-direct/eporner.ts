import { ytdlpPlugin } from '../ytdlp'
import {
  BROWSER_UA,
  PageParseError,
  cleanTitle,
  fetchPage,
  pageDirectPlugin,
  siteFetch,
  type ParsedPage,
  type VideoOffer
} from './common'

/**
 * eporner. Required rather than optional: yt-dlp's extractor reports
 * "Unable to extract hash" (tested against the live site, 2026-07-26), because the *video* page is
 * behind a geo-triggered age wall in some regions and never carries the hash at
 * all. The **embed** page is not walled — it exists for third-party sites — and
 * has everything needed.
 *
 * Two steps:
 *   1. `/embed/{id}/`      → a 32-hex `hash` and the title
 *   2. `/xhr/video/{id}`   → JSON listing one direct mp4 per resolution
 *
 * The xhr endpoint wants the hash re-encoded: four 8-digit hex chunks, each
 * parsed as an integer and written back in base 36.
 *
 * The resulting links embed both an expiry and the requesting IP
 * (`…/1785095931_23.142.200.219_1262/…`), so they are strictly single-use from
 * this machine — exactly the just-in-time resolve the queue already does.
 */

const BASE = process.env.FSMGR_EPORNER_BASE || 'https://www.eporner.com'

/** `/video-90MOExIF6BI/slug/`, `/hd-porn/90MOExIF6BI/Slug/`, `/embed/90MOExIF6BI/`. */
const ID_PATTERNS = [
  /\/video-([A-Za-z0-9]+)/,
  /\/hd-porn\/([A-Za-z0-9]+)/,
  /\/embed\/([A-Za-z0-9]+)/,
  /\/video\/([A-Za-z0-9]+)/
]

function videoId(pageUrl: string): string {
  for (const re of ID_PATTERNS) {
    const id = re.exec(pageUrl)?.[1]
    if (id) return id
  }
  throw new PageParseError('no_video_id')
}

/** 32 hex → four base-36 chunks, the form `/xhr/video/` expects. */
export function encodeHash(hash: string): string {
  const chunks = hash.match(/.{8}/g)
  if (!chunks || chunks.length !== 4) throw new PageParseError('bad_hash')
  return chunks.map((chunk) => parseInt(chunk, 16).toString(36)).join('')
}

interface XhrSource {
  src?: string
  labelShort?: string
}

interface XhrResponse {
  sources?: { mp4?: Record<string, XhrSource> }
  message?: string
}

/** "1080p HD" / "720p" → 1080 / 720. */
function heightOf(key: string, source: XhrSource): number {
  const label = source.labelShort ?? key
  return Number(/(\d{3,4})\s*p/i.exec(label)?.[1] ?? 0)
}

async function parse(pageUrl: string): Promise<ParsedPage> {
  const id = videoId(pageUrl)
  const embedUrl = `${BASE}/embed/${id}/`
  // A Referer from elsewhere is what an embed normally sees; the page behaves
  // the same either way, but this is the honest request to make.
  const embed = await fetchPage(embedUrl, { Referer: `${BASE}/` })

  const hash = /hash\s*=\s*['"]([0-9a-f]{32})['"]/i.exec(embed)?.[1]
  if (!hash) {
    // The wall renders instead of the player when it is in play.
    if (/ageverifybox|Age Verification/i.test(embed)) throw new PageParseError('age_wall')
    throw new PageParseError('no_hash')
  }

  const titleRaw = /<title>([^<]*)<\/title>/i.exec(embed)?.[1] ?? id
  const title = cleanTitle(titleRaw, /\s*[-–]\s*EPORNER\s*$/i)

  const query = new URLSearchParams({
    hash: encodeHash(hash),
    domain: new URL(BASE).hostname,
    fallback: 'false',
    embed: 'false',
    supportedFormats: 'dash,mp4'
  })
  const res = await siteFetch(`${BASE}/xhr/video/${id}?${query}`, {
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: 'application/json',
      Referer: embedUrl,
      'X-Requested-With': 'XMLHttpRequest'
    }
  })
  if (!res.ok) throw new PageParseError(`xhr_http_${res.status}`)

  let data: XhrResponse
  try {
    data = (await res.json()) as XhrResponse
  } catch {
    throw new PageParseError('xhr_not_json')
  }

  const mp4 = data.sources?.mp4 ?? {}
  const offers: VideoOffer[] = []
  for (const [key, source] of Object.entries(mp4)) {
    if (!source?.src) continue
    const height = heightOf(key, source)
    if (height > 0) offers.push({ height, label: source.labelShort ?? key, url: source.src })
  }
  if (offers.length === 0) throw new PageParseError('no_mp4_sources')

  return { offers, title, ext: '.mp4' }
}

export const epornerPlugin = pageDirectPlugin({
  id: 'eporner',
  hosts: [/(^|\.)eporner\.com$/i],
  hostsEnv: 'FSMGR_EPORNER_HOSTS',
  parse,
  referer: () => `${BASE}/`,
  unavailableReason: 'eporner_unavailable',
  // Kept as the safety net even though it is currently broken
  // upstream: if eporner drops the wall, yt-dlp starts working again on its own.
  fallback: ytdlpPlugin
})
