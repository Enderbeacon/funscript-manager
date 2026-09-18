import {
  PageParseError,
  cleanTitle,
  fetchPage,
  pageDirectPlugin,
  type ParsedPage,
  type VideoOffer
} from './common'

/**
 * hanime1. The watch page carries the player's own `<source>` list,
 * with the resolution in the `size` attribute:
 *
 *   <source src="https://vdownload-3.hembed.com/407349-720p.mp4?token=…&amp;expires=1789795148"
 *           type="video/mp4" size="720">
 *
 * The query pairs a signature with an expiry timestamp, so the link is
 * re-resolved on every resume like every other page-direct source. It is an
 * HTML attribute, so its `&` arrives as `&amp;`; left encoded, the CDN reads no
 * expiry and answers 403.
 *
 * No yt-dlp fallback exists for this site (yt-dlp does not accept extractors
 * for sites like it), so a parse failure fails the job with `hanime1_parse_failed` and
 * the user is pointed at pasting a direct link instead.
 */

const BASE = process.env.FSMGR_HANIME1_BASE || 'https://hanime1.me'

const SOURCE_TAG = /<source\b[^>]*>/gi
const ATTR = (name: string): RegExp => new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i')

function videoId(pageUrl: string): string | null {
  try {
    return new URL(pageUrl).searchParams.get('v')
  } catch {
    return null
  }
}

async function parse(pageUrl: string): Promise<ParsedPage> {
  const id = videoId(pageUrl)
  if (!id) throw new PageParseError('no_video_id')

  const html = await fetchPage(`${BASE}/watch?v=${id}`, {
    Referer: `${BASE}/`,
    'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8'
  })

  const offers: VideoOffer[] = []
  for (let m = SOURCE_TAG.exec(html); m !== null; m = SOURCE_TAG.exec(html)) {
    const tag = m[0]
    const src = ATTR('src').exec(tag)?.[1]?.replace(/&amp;/g, '&')
    if (!src || !/\.mp4/i.test(src)) continue
    // `size` is the height on this player; the file name repeats it as a suffix.
    const height = Number(
      ATTR('size').exec(tag)?.[1] ?? /-(\d{3,4})p\.mp4/i.exec(src)?.[1] ?? 0
    )
    if (height > 0) offers.push({ height, label: `${height}p`, url: src })
  }
  SOURCE_TAG.lastIndex = 0

  if (offers.length === 0) {
    if (/登入|login|sign in/i.test(html) && !/<source/i.test(html)) {
      throw new PageParseError('login_required')
    }
    throw new PageParseError('no_sources')
  }

  // The title ends in the site's own tagline and name, matched below by the
  // tagline's first word or the site name; everything from there onward is
  // noise in a file name. Entities are decoded first — the separators arrive
  // as `&nbsp;-&nbsp;`, which no plain dash pattern would match.
  const titleRaw = cleanTitle(/<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? id)
  const title = cleanTitle(titleRaw.split(/\s*[-–]\s*(?=H動漫|Hanime1)/)[0] ?? titleRaw)

  return { offers, title, ext: '.mp4' }
}

export const hanime1Plugin = pageDirectPlugin({
  id: 'hanime1',
  hosts: [/(^|\.)hanime1\.me$/i],
  hostsEnv: 'FSMGR_HANIME1_HOSTS',
  parse,
  // The CDN is a different host than the page; it checks the site as referer.
  referer: () => `${BASE}/`,
  unavailableReason: 'hanime1_unavailable'
})
