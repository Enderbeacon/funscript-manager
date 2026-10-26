import { ytdlpPlugin } from '../ytdlp'
import {
  PageParseError,
  cleanTitle,
  fetchPage,
  pageDirectPlugin,
  type ParsedPage,
  type VideoOffer
} from './common'

/**
 * rule34video. The video page carries one download anchor per resolution,
 * and each href already carries the file name:
 *
 *   <a class="tag_item tag_item_download"
 *      href="…/get_file/…/4511101_1080p.mp4/?v-acctoken=…&download=true
 *            &download_filename=stellar-breast_1080p.mp4">MP4 1080p</a>
 *
 * The anchors can live in a row or a hidden download menu with nested icons
 * and file sizes. Their class and URL identify them without depending on the
 * surrounding layout or needing JavaScript to open the menu.
 *
 * `v-acctoken` is a signature, so the link is short-lived and re-resolved on
 * every resume. Verified against the live site: no session cookie is needed,
 * the CDN answers 206 for a mid-file Range, and it sets Content-Disposition.
 */

const BASE = process.env.FSMGR_R34_BASE || 'https://rule34video.com'

const ANCHOR = /<a\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/a\s*>/gi
const ATTRIBUTE = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g

/** `MP4 1080p` → 1080. */
function heightOf(label: string, url: string): number {
  const fromLabel = /(\d{3,4})\s*p/i.exec(label)?.[1]
  if (fromLabel) return Number(fromLabel)
  // Some entries are labelled only "MP4"; the path still says `…_720p.mp4`.
  const fromUrl = /_(\d{3,4})p?\.mp4/i.exec(url)?.[1]
  return fromUrl ? Number(fromUrl) : 0
}

function decodeEntities(raw: string): string {
  const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }
  return raw.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (entity, code: string) => {
    const key = code.toLowerCase()
    if (!key.startsWith('#')) return named[key] ?? entity
    const point = key.startsWith('#x') ? parseInt(key.slice(2), 16) : Number(key.slice(1))
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : entity
  })
}

export function parseRule34VideoPage(html: string, pageUrl: string): ParsedPage {
  const offers: VideoOffer[] = []
  const seen = new Set<string>()
  // matchAll gives each parse its own cursor, including concurrent resolves.
  for (const m of html.matchAll(ANCHOR)) {
    const attrs: Record<string, string> = {}
    for (const attr of m[1]!.matchAll(ATTRIBUTE)) {
      attrs[attr[1]!.toLowerCase()] = decodeEntities(attr[2] ?? attr[3] ?? attr[4] ?? '')
    }
    if (!attrs.class?.split(/\s+/).includes('tag_item_download') || !attrs.href) continue
    let url: URL
    try {
      url = new URL(attrs.href, pageUrl)
    } catch {
      continue
    }
    if (
      !/^https?:$/.test(url.protocol) ||
      !url.pathname.startsWith('/get_file/') ||
      !/\.mp4\/?$/i.test(url.pathname) ||
      url.searchParams.get('download') !== 'true' ||
      seen.has(url.href)
    ) {
      continue
    }
    const text = cleanTitle(
      decodeEntities(m[2]!.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '').replace(/<[^>]*>/g, ''))
    )
    const height = heightOf(text, url.pathname)
    if (height === 0) continue
    seen.add(url.href)
    // `download_filename` names *this* resolution (`stellar-breast_720p.mp4`),
    // and it is what Content-Disposition repeats on the file itself. It has to
    // be kept per offer: taking the first link's name labelled every download
    // 1080p regardless of which one the quality preference actually chose.
    const named = url.searchParams.get('download_filename')
    // Normalize the label so the menu's file-size text is not included.
    offers.push({
      height,
      label: `MP4 ${height}p`,
      url: url.href,
      ...(named ? { fileName: cleanTitle(named) } : {})
    })
  }
  if (offers.length === 0) throw new PageParseError('no_download_links')

  const title = cleanTitle(
    decodeEntities(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1]?.replace(/<[^>]*>/g, '') ?? 'video')
  )
  return { offers, title, ext: '.mp4' }
}

async function parse(pageUrl: string): Promise<ParsedPage> {
  const html = await fetchPage(pageUrl, { Referer: `${BASE}/` })
  return parseRule34VideoPage(html, pageUrl)
}

export const rule34videoPlugin = pageDirectPlugin({
  id: 'rule34video',
  hosts: [/(^|\.)rule34video\.com$/i],
  hostsEnv: 'FSMGR_R34_HOSTS',
  parse,
  referer: () => `${BASE}/`,
  unavailableReason: 'r34_unavailable',
  fallback: ytdlpPlugin
})
