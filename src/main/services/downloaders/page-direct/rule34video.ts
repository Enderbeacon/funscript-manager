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
 * rule34video. The video page renders a "Download" row with one
 * `<a>` per resolution, and each href already carries the file name:
 *
 *   <div class="label">Download</div>
 *   <a class="tag_item tag_item_download"
 *      href="…/get_file/…/4511101_1080p.mp4/?v-acctoken=…&download=true
 *            &download_filename=stellar-breast_1080p.mp4">MP4 1080p</a>
 *
 * `v-acctoken` is a signature, so the link is short-lived and re-resolved on
 * every resume. Verified against the live site: no session cookie is needed,
 * the CDN answers 206 for a mid-file Range, and it sets Content-Disposition.
 */

const BASE = process.env.FSMGR_R34_BASE || 'https://rule34video.com'

const DOWNLOAD_BLOCK = /<div[^>]*class="[^"]*\blabel\b[^"]*"[^>]*>\s*Download\s*<\/div>([\s\S]*?)<\/div>/i
const ANCHOR = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g

/** `MP4 1080p` → 1080. */
function heightOf(label: string, url: string): number {
  const fromLabel = /(\d{3,4})\s*p/i.exec(label)?.[1]
  if (fromLabel) return Number(fromLabel)
  // Some entries are labelled only "MP4"; the path still says `…_720p.mp4`.
  const fromUrl = /_(\d{3,4})p?\.mp4/i.exec(url)?.[1]
  return fromUrl ? Number(fromUrl) : 0
}

function decodeEntities(url: string): string {
  return url.replace(/&amp;/g, '&')
}

async function parse(pageUrl: string): Promise<ParsedPage> {
  const html = await fetchPage(pageUrl, { Referer: `${BASE}/` })

  const block = DOWNLOAD_BLOCK.exec(html)?.[1]
  if (!block) throw new PageParseError('no_download_block')

  const offers: VideoOffer[] = []
  for (let m = ANCHOR.exec(block); m !== null; m = ANCHOR.exec(block)) {
    const url = decodeEntities(m[1]!)
    const label = cleanTitle(m[2]!.replace(/<[^>]*>/g, ''))
    if (!/get_file|\.mp4/i.test(url)) continue
    const height = heightOf(label, url)
    if (height === 0) continue
    // `download_filename` names *this* resolution (`stellar-breast_720p.mp4`),
    // and it is what Content-Disposition repeats on the file itself. It has to
    // be kept per offer: taking the first link's name labelled every download
    // 1080p regardless of which one the quality preference actually chose.
    const named = new URL(url, BASE).searchParams.get('download_filename')
    offers.push({ height, label, url, ...(named ? { fileName: cleanTitle(named) } : {}) })
  }
  ANCHOR.lastIndex = 0
  if (offers.length === 0) throw new PageParseError('no_offers_in_block')

  const title = cleanTitle(
    /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1]?.replace(/<[^>]*>/g, '') ?? 'video'
  )
  return { offers, title, ext: '.mp4' }
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
