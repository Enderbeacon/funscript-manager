import { basename } from 'node:path'
import type { LinkSection, ScrapedLink, ScrapedPost } from '@shared/schemas/scraped-post'

/**
 * EroScripts post parsing. Pure functions over the topic JSON, so
 * the heuristics can be smoke-tested without touching the forum.
 *
 * Community posts follow a Preview / Details / Video link / Script layout by
 * convention only, so nothing here is required to match: a section that is
 * missing just leaves its links classified as unknown, and the user picks.
 */

const SECTION_PATTERNS: { section: LinkSection | 'details' | 'heatmap'; re: RegExp }[] = [
  { section: 'preview', re: /^(preview|preview\s*gif|preview\s*image|teaser)\b/i },
  { section: 'details', re: /^(details?|description|info|about)\b/i },
  { section: 'heatmap', re: /^(length|heatmap|funscript\s*info|duration)\b/i },
  { section: 'script', re: /^(scripts?|funscripts?|haptic\s*scripts?)\b/i },
  { section: 'video', re: /^(video\s*links?|videos?|downloads?|sources?|links?)\b/i }
]

const HOSTERS: { host: RegExp; hoster: ScrapedLink['hoster'] }[] = [
  {
    host: /(^|\.)(?:pixeldrain\.(?:com|net|nl|biz|tech|dev)|pixeldra\.in)$/i,
    hoster: 'pixeldrain'
  },
  { host: /(^|\.)mega\.(nz|io)$/i, hoster: 'mega' },
  { host: /(^|\.)gofile\.io$/i, hoster: 'gofile' },
  { host: /(^|\.)(drive|docs)\.google\.com$/i, hoster: 'gdrive' },
  { host: /(^|\.)dropbox\.com$/i, hoster: 'dropbox' },
  { host: /(^|\.)mediafire\.com$/i, hoster: 'mediafire' },
  { host: /(^|\.)eporner\.com$/i, hoster: 'eporner' },
  { host: /(^|\.)hanime1\.me$/i, hoster: 'hanime1' },
  { host: /(^|\.)hanime\.tv$/i, hoster: 'hanimetv' },
  { host: /(^|\.)pornhub\.com$/i, hoster: 'pornhub' },
  { host: /(^|\.)rule34video\.com$/i, hoster: 'rule34video' },
  { host: /(^|\.)spankbang\.(com|party)$/i, hoster: 'spankbang' },
  { host: /(^|\.)patreon\.com$/i, hoster: 'patreon' },
  { host: /(^|\.)payhip\.com$/i, hoster: 'payhip' }
]

/**
 * Hosts with no automated downloader — the UI offers them as "open in browser"
 * instead of a tick box.
 *
 * Only patreon remains, and it stays for good: its internal API changes often
 * and needs a logged-in session kept alive, for a small share of posts. payhip left the list because its rows now take a pasted direct
 * link instead of nothing at all.
 */
const MANUAL_ONLY = new Set(['patreon'])

/**
 * Hosts whose link is a store or landing page rather than a file. They can be
 * downloaded, but only from the address the user was given after paying, so the
 * row asks for it.
 */
const NEEDS_MANUAL_LINK = new Set(['payhip'])

export function hosterOf(url: string): ScrapedLink['hoster'] {
  try {
    const { hostname } = new URL(url)
    return HOSTERS.find((h) => h.host.test(hostname))?.hoster ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

interface Heading {
  index: number
  section: LinkSection | 'details' | 'heatmap'
}

/**
 * A heading's own word, with the decoration taken off.
 *
 * Authors on this forum head their sections with an icon far more often than
 * not, and every pattern below is anchored at the start, so the icon used to
 * make the whole heading unrecognisable — and with it every link underneath.
 * A real post read `### :movie_camera: Video link` and `### :file_folder:
 * Script`; both came out unclassified, so the Patreon link the author had filed
 * under Script was sorted into Video by its domain, and the Twitter link under
 * Video link was thrown away as noise.
 *
 * Two forms of icon, and the order here matters:
 *
 * 1. **Discourse emoji shortcodes** — `:movie_camera:`, plain ASCII, which is
 *    what the forum's own composer inserts. These must go first: stripping
 *    markdown emphasis would eat the underscore inside the name and leave
 *    `:moviecamera:` behind.
 * 2. **Literal emoji**, for authors who paste the character itself.
 *
 * After that, anything before the first letter or digit is decoration —
 * variation selectors, bullets, arrows, whitespace — not part of the name the
 * author gave the section.
 */
function headingWord(rawHeading: string): string {
  return rawHeading
    .replace(/:[a-z0-9_+-]+:/gi, ' ') // Discourse emoji shortcode
    .replace(/[*`~[\]]/g, '') // bold/italic/link syntax
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .trim()
}

/** Headings in document order, each mapped to the section it introduces. */
function headings(raw: string): Heading[] {
  const found: Heading[] = []
  const re = /^[ \t]*#{1,6}[ \t]*(.+?)[ \t]*$/gm
  for (let m = re.exec(raw); m !== null; m = re.exec(raw)) {
    const text = headingWord(m[1]!)
    const hit = SECTION_PATTERNS.find((p) => p.re.test(text))
    found.push({ index: m.index, section: hit?.section ?? 'unknown' })
  }
  return found
}

/** The section a character offset falls in: the nearest heading above it. */
function sectionAt(list: Heading[], index: number): LinkSection {
  let current: Heading['section'] = 'unknown'
  for (const h of list) {
    if (h.index > index) break
    current = h.section
  }
  // details/heatmap carry no downloads; treat their links as unclassified.
  return current === 'video' || current === 'script' || current === 'preview' ? current : 'unknown'
}

/** Forum navigation, not content: profiles, other threads, categories, tags. */
const FORUM_NAV = /^\/(u|t|c|tag|tags|g|search|latest|top|categories|badges|about|faq|my)(\/|$)/i

const IMAGE_EXT = /\.(gif|png|jpe?g|webp|svg|bmp|avif|ico)(\?|$)/i

/**
 * A URL as it sits in a post's markdown. Backticks and square brackets end it:
 * none of them may appear unencoded in an address, and markdown puts all three
 * right against one. Without that, `` `https://mega.nz/file/x#key` `` is read
 * with the backtick on the end — a mega key with a stray character decrypts
 * nothing, so a working link shows as dead — and `[https://a](https://a)` is
 * read as a single address with the markup glued into the middle.
 */
function urlsIn(): RegExp {
  return /https?:\/\/[^\s)<>"'`[\]]+/g
}

/** Invisible characters authors paste into link text along with the words. */
const INVISIBLE = /[\u200b-\u200d\u2060\ufeff]/g

/**
 * Is this link certainly not something to download? Kept deliberately narrow:
 * anything not matched here stays in the list, because a missing download link
 * is a much worse failure than one extra row the user ignores.
 */
function isNotADownload(url: string, baseUrl: string): boolean {
  if (IMAGE_EXT.test(url)) return true
  try {
    const parsed = new URL(url)
    if (parsed.origin === new URL(baseUrl).origin) return FORUM_NAV.test(parsed.pathname)
    // Well-known non-file destinations that show up in prose all the time.
    return /(^|\.)(github\.com|discord\.(gg|com)|twitter\.com|x\.com|reddit\.com|youtube\.com|youtu\.be|imgur\.com)$/i.test(
      parsed.hostname
    )
  } catch {
    return true
  }
}

/** Trailing punctuation markdown leaves attached to a bare URL. */
function trimUrl(url: string): string {
  return url.replace(/[),.;:'"\]*`]+$/, '')
}

/**
 * Discourse shortens a long bare URL for display, leaving markdown like
 * `[https://mega.nz/file/ab#xS6qLSnku ... OG9fhaoIeM](https://mega.nz/file/ab#xS6qLSnkuCSlx…full…)`.
 * Scanning for URLs finds the label's leading fragment as well as the real
 * target, and that shortened copy is a broken link — half a mega key decrypts
 * nothing. Collect those prefixes so only the full target survives.
 */
function shortenedLabels(raw: string): Set<string> {
  const shadowed = new Set<string>()
  const re = /\[(https?:\/\/[^\]]*)\]\((https?:\/\/[^)\s]+)\)/g
  for (let m = re.exec(raw); m !== null; m = re.exec(raw)) {
    const label = trimUrl((m[1] ?? '').split(/\s/)[0] ?? '')
    const target = m[2] ?? ''
    if (label && label !== target && target.startsWith(label)) shadowed.add(label)
  }
  return shadowed
}

/**
 * A fragment is display state on some hosts and the decryption key on others.
 * pixeldrain's `#item=2` only selects a row in its folder viewer, so three
 * links into one album are one download, not three — mega's `#key` must
 * obviously be left alone.
 */
function canonicalUrl(url: string, hoster: ScrapedLink['hoster']): string {
  if (hoster !== 'pixeldrain') return url
  const hash = url.indexOf('#')
  return hash === -1 ? url : url.slice(0, hash)
}

/** Entities that matter when reading URLs back out of rendered HTML. */
function unescapeHtml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
}

/**
 * Rendered HTML back into something the markdown scanner can read: headings
 * become `#` lines and every href becomes a bare URL at its own position.
 *
 * Only used when the API did not give us `raw` — see fetchPost. A forum that
 * stops serving raw must not silently cost the user every link in the post.
 */
export function cookedToMarkdown(cooked: string): string {
  return unescapeHtml(
    cooked
      .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, text: string) => {
        return `\n${'#'.repeat(Number(level))} ${text.replace(/<[^>]+>/g, '').trim()}\n`
      })
      .replace(/<a\b[^>]*\bhref="([^"]+)"[^>]*>/gi, (_, href: string) => ` ${href} `)
      .replace(/<(br|\/p|\/div|\/li|\/tr)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
}

/** Extensions the generic downloader can take straight off a URL. */
const FILE_EXT = /\.(mp4|mkv|webm|mov|avi|wmv|m4v|ts|flv|mp3|m4a|flac|wav|opus|funscript|zip|rar|7z)(\?|$)/i

/**
 * Forum attachments in a post's rendered HTML.
 *
 * Attachments have to be read from cooked: raw carries Discourse's
 * `upload://<hash>` short form, which is not a URL anything can fetch. This
 * used to accept `.funscript` and nothing else, which quietly threw away every
 * other attachment people post — and a set of scripts zipped up, or a small
 * clip attached directly, is a normal way to re-upload in a reply. Anything the
 * generic downloader can take off a file name is kept now.
 *
 * The label is what decides for `/short-url/` hrefs: that form hides the
 * extension, so the anchor text is the only thing separating a re-posted
 * archive from a screenshot.
 */
function attachmentLinks(
  cooked: string,
  baseUrl: string,
  from: ScrapedLink['fromPost']
): ScrapedLink[] {
  const found: ScrapedLink[] = []
  const hrefRe = /href="([^"]+)"/gi
  for (let m = hrefRe.exec(cooked); m !== null; m = hrefRe.exec(cooked)) {
    const href = unescapeHtml(m[1]!)
    if (!/\/uploads\//i.test(href)) continue
    const url = href.startsWith('http')
      ? href
      : `${baseUrl}${href.startsWith('/') ? '' : '/'}${href}`
    const after = cooked.slice(m.index)
    // Anchor text is still HTML: `Tifa &amp; Cloud` has to become `Tifa & Cloud`
    // before it is anybody's file name.
    const text = unescapeHtml(/^[^>]*>([^<]+)</.exec(after)?.[1] ?? '')
    const label = text.replace(INVISIBLE, '').trim() || fileNameOf(url)
    // The name that carries the extension: the href for a direct upload path,
    // the anchor text for the short-url form.
    const named = FILE_EXT.test(url) ? url : FILE_EXT.test(label) ? label : null
    if (!named || IMAGE_EXT.test(named)) continue
    const isScript = /\.funscript$/i.test(named)
    found.push({
      url,
      hoster: 'attachment',
      section: isScript ? 'script' : 'video',
      label,
      isAttachment: true,
      isScript,
      manualOnly: false,
      needsManualLink: false,
      downloadable: true,
      note: '',
      fromPost: from
    })
  }
  return found
}

/**
 * Can we fetch this ourselves? Either a plugin claims the host, or the address
 * ends in a file the generic downloader can pull. Anything else is a page — a
 * shop, a Patreon, a landing page — and pretending otherwise downloads HTML.
 */
function isFetchable(url: string, claimed: (url: string) => boolean): boolean {
  return claimed(url) || FILE_EXT.test(url)
}

/** Markdown decoration that would otherwise end up quoted back at the user. */
function plainText(line: string): string {
  return line
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(urlsIn(), '')
    // Emoji shortcodes go before the markdown strip, or `_` removal turns
    // `:slight_smile:` into the word `slightsmile` (same trap as headings).
    .replace(/:[a-z0-9_+-]+:/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\/?[a-z][^\]]*\]/gi, '') // bbcode the forum still accepts
    .replace(/[*_`>#]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s:—–-]+|[\s:—–-]+$/g, '')
    .trim()
}

/**
 * What the author wrote about this link. Two shapes both occur in real posts:
 * the sentence runs into the link on one line ("DMM Link (to buy): https://…"),
 * or it sits on the line above it ("…syncs much better imo:" then the URL).
 * Take the same line when it says anything, else the nearest line above.
 *
 * Headings are not notes — a note under "Video link" would just repeat the
 * group the link is already filed under.
 */
function noteAt(raw: string, index: number): string {
  const before = raw.lastIndexOf('\n', index) + 1
  const lineEnd = raw.indexOf('\n', index)
  const line = raw.slice(before, lineEnd === -1 ? raw.length : lineEnd)
  const own = plainText(line)
  if (own) return own.slice(0, 300)

  const above = raw.slice(0, before).split('\n')
  for (let i = above.length - 1, looked = 0; i >= 0 && looked < 3; i--, looked++) {
    const candidate = above[i] ?? ''
    if (/^\s*#{1,6}\s/.test(candidate)) return ''
    const text = plainText(candidate)
    if (text) return text.slice(0, 300)
  }
  return ''
}

/** The reply's own words, for the quote shown under a replacement link. */
function replyExcerpt(raw: string): string {
  const text = raw
    .split('\n')
    .map((line) => plainText(line))
    .filter(Boolean)
    .join(' ')
  return text.slice(0, 280)
}

/**
 * The post's poster frame. Read from cooked because raw carries Discourse's
 * `upload://` short form, which no <img> can load.
 */
export function extractPreviewImage(cooked: string): string {
  const re = /<img\b[^>]*\bsrc="([^"]+)"/gi
  for (let m = re.exec(cooked); m !== null; m = re.exec(cooked)) {
    const src = unescapeHtml(m[1] ?? '')
    if (!/^https?:\/\//i.test(src)) continue
    // Emoji and avatars are markup, not content.
    if (/\/images\/emoji\/|\/user_avatar\/|\/letter_avatar/i.test(src)) continue
    return src
  }
  return ''
}

function fileNameOf(url: string): string {
  try {
    const name = basename(new URL(url).pathname)
    return name ? decodeURIComponent(name) : url
  } catch {
    return url
  }
}

/**
 * External links come from the raw markdown, where they are plain URLs.
 * Forum attachments do NOT: Discourse rewrites uploads to `upload://<hash>`
 * short forms in raw, and only the cooked HTML carries a fetchable href — so
 * attachments are read from cooked instead.
 */
export interface ScanOptions {
  /**
   * Whether a real downloader plugin claims this URL, injected rather than
   * looked up here — it keeps this module pure over the topic JSON, and it
   * means the answer always matches what the queue would actually do.
   *
   * Without it the parser falls back to its own host table, which is a
   * superset for display purposes but says nothing about downloadability.
   */
  isDownloadable?: (url: string) => boolean
  /** Links already collected from earlier posts, so a repost is not listed twice. */
  seen?: Set<string>
}

export function extractLinks(
  raw: string,
  cooked: string,
  baseUrl: string,
  options: ScanOptions = {}
): ScrapedLink[] {
  const list = headings(raw)
  const links: ScrapedLink[] = []
  const seen = options.seen ?? new Set<string>()
  const downloadable = options.isDownloadable ?? ((): boolean => false)

  const push = (link: ScrapedLink): void => {
    if (seen.has(link.url)) return
    seen.add(link.url)
    links.push(link)
  }

  const shadowed = shortenedLabels(raw)
  const urlRe = urlsIn()
  for (let m = urlRe.exec(raw); m !== null; m = urlRe.exec(raw)) {
    const found = trimUrl(m[0])
    // A display-shortened copy of a link we are also collecting in full.
    if (shadowed.has(found)) continue
    const hoster = hosterOf(found)
    const url = canonicalUrl(found, hoster)
    const section = sectionAt(list, m.index)
    const isFunscript = /\.funscript(\?|$)/i.test(url)
    // A forum upload written out in full (older posts do this).
    const isAttachment = url.startsWith(baseUrl) && /\/uploads\//i.test(url)
    // Only drop what is definitely not a download. An unrecognised host is
    // NOT dropped — silently hiding someone's link is far worse than an extra
    // row; it lands in the picker's "other links" group instead.
    //
    // And nothing filed under the post's own Video/Script heading is dropped
    // at all: the author put it there to be downloaded, whatever the host is.
    const authorSaidItIsADownload = section === 'video' || section === 'script'
    if (
      !isAttachment &&
      !isFunscript &&
      !authorSaidItIsADownload &&
      hoster === 'unknown' &&
      // A plugin claiming the URL outranks the host table: registering a new
      // downloader should be enough for its links to stop looking like noise.
      !downloadable(url) &&
      isNotADownload(url, baseUrl)
    ) {
      continue
    }
    push({
      url,
      hoster: isAttachment ? 'attachment' : hoster,
      section,
      // A file name only means something when the URL ends in one. For a host
      // page the last path segment is an opaque id, so show the whole link.
      label: isAttachment || isFunscript ? fileNameOf(url) : url,
      isAttachment,
      isScript: isFunscript || section === 'script',
      manualOnly: MANUAL_ONLY.has(hoster),
      needsManualLink: NEEDS_MANUAL_LINK.has(hoster),
      downloadable: isAttachment || isFetchable(url, downloadable),
      note: noteAt(raw, m.index),
      fromPost: null
    })
  }

  for (const attachment of attachmentLinks(cooked, baseUrl, null)) push(attachment)

  return links
}

/** A reply as it reaches the scanner. */
export interface ReplyPost {
  raw?: string | undefined
  cooked?: string | undefined
  username?: string | undefined
  post_number?: number | undefined
  created_at?: string | undefined
}

const MEDIA_EXT = /\.(mp4|mkv|webm|mov|avi|wmv|m4v|ts|flv|mp3|m4a|flac|wav|opus)(\?|$)/i

/**
 * Links people posted in the replies.
 *
 * Older threads lose their original upload often enough that the replies are
 * where the working link lives, so they are collected too. Replies have no
 * Video/Script headings to go by, though — only the link itself — so the bar is
 * different from the opening post's: a reply link counts when a downloader
 * claims it, when its host is one we know but cannot automate (so it can still
 * be pointed at), or when it is a funscript. Everything else in a 200-post
 * thread is conversation, and listing it would bury the two links that matter.
 *
 * Where a link cannot be sorted by structure it is sorted by what it is: a
 * funscript is a script, anything else is treated as a video, which is what a
 * re-upload almost always is.
 */
export function extractReplyLinks(
  replies: ReplyPost[],
  baseUrl: string,
  options: ScanOptions = {}
): ScrapedLink[] {
  const seen = options.seen ?? new Set<string>()
  const downloadable = options.isDownloadable ?? ((): boolean => false)
  const links: ScrapedLink[] = []

  for (const reply of replies) {
    const cooked = asString(reply.cooked)
    const raw = asString(reply.raw) || cookedToMarkdown(cooked)
    const from = {
      number: typeof reply.post_number === 'number' ? reply.post_number : 0,
      author: asString(reply.username),
      createdAt: asString(reply.created_at),
      excerpt: replyExcerpt(raw)
    }

    const push = (link: ScrapedLink): void => {
      if (seen.has(link.url)) return
      seen.add(link.url)
      links.push(link)
    }

    const shadowed = shortenedLabels(raw)
    const urlRe = urlsIn()
    for (let m = urlRe.exec(raw); m !== null; m = urlRe.exec(raw)) {
      const found = trimUrl(m[0])
      if (shadowed.has(found)) continue
      const hoster = hosterOf(found)
      const url = canonicalUrl(found, hoster)
      if (IMAGE_EXT.test(url)) continue
      const isFunscript = /\.funscript(\?|$)/i.test(url)
      // Known-but-unautomated hosts stay: the user still wants to be told the
      // replacement exists, even when fetching it is their job. So does a bare
      // file on a host nobody has heard of — `https://someones-box/clip.mp4` is
      // a re-upload the generic downloader can take, and requiring a *known*
      // host was throwing exactly those away.
      const worthShowing = isFunscript || hoster !== 'unknown' || isFetchable(url, downloadable)
      if (!worthShowing) continue

      push({
        url,
        hoster,
        section: isFunscript ? 'script' : 'video',
        label: isFunscript || MEDIA_EXT.test(url) ? fileNameOf(url) : url,
        isAttachment: false,
        isScript: isFunscript,
        manualOnly: MANUAL_ONLY.has(hoster),
        needsManualLink: NEEDS_MANUAL_LINK.has(hoster),
        downloadable: isFetchable(url, downloadable),
        note: '',
        fromPost: from
      })
    }

    // Re-uploads posted as attachments — scripts, but also the zipped-up sets
    // and short clips people attach. Only the rendered HTML has a fetchable
    // address for them (see attachmentLinks).
    for (const attachment of attachmentLinks(cooked, baseUrl, from)) push(attachment)
  }

  return links
}

/**
 * A link the user added to a post themselves: a mirror found elsewhere, or the
 * direct file a page that would not parse left them to find. Described the way
 * the post's own links are, so it downloads and files along with the post.
 *
 * Anything the user pasted on purpose is taken as a download, except a host
 * that is only ever a page to visit.
 */
export function pastedLink(url: string): ScrapedLink {
  const hoster = hosterOf(url)
  const isScript = /\.funscript(\?|$)/i.test(url)
  return {
    url,
    hoster,
    section: isScript ? 'script' : 'video',
    label: isScript || MEDIA_EXT.test(url) ? fileNameOf(url) : url,
    isAttachment: false,
    isScript,
    manualOnly: MANUAL_ONLY.has(hoster),
    needsManualLink: false,
    downloadable: !MANUAL_ONLY.has(hoster),
    note: '',
    fromPost: null
  }
}

/** Plain text of the details section, for the confirmation panel. */
export function extractDescription(raw: string): string {
  const list = headings(raw)
  const start = list.findIndex((h) => h.section === 'details')
  if (start === -1) return ''
  const from = raw.indexOf('\n', list[start]!.index)
  const to = list[start + 1]?.index ?? raw.length
  if (from === -1 || from >= to) return ''
  return raw
    .slice(from, to)
    // The forum's new-topic template puts an HTML comment in every section
    // telling the author what to write. It is invisible in a browser but we
    // read the markdown, so it has to go — and before the `>` strip below,
    // which would otherwise leave a stray `--` where the comment closed.
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → their text
    .replace(/[*_`>#]/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 1200)
}

export interface TopicJson {
  id?: number
  title?: string
  /** Strings on plain Discourse; EroScripts serves objects (see normalizeTags). */
  tags?: unknown
  created_at?: string
  post_stream?: {
    posts?: {
      id?: number
      raw?: string
      cooked?: string
      username?: string
      post_number?: number
      created_at?: string
    }[]
    /** Ids of every post in the thread; the first response only carries ~20. */
    stream?: number[]
  }
}

/**
 * Discourse's `tags` is documented as a string array, but instances can serve
 * objects instead — EroScripts does, which broke parsing on the first real
 * post tried. Take whichever field carries the name and drop anything
 * unreadable rather than failing the whole post over its tags.
 */
export function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const tags: string[] = []
  for (const entry of raw) {
    if (typeof entry === 'string') {
      if (entry.trim()) tags.push(entry.trim())
      continue
    }
    if (entry && typeof entry === 'object') {
      const o = entry as Record<string, unknown>
      const value = o.name ?? o.tag ?? o.text ?? o.slug ?? o.id
      if (typeof value === 'string' && value.trim()) tags.push(value.trim())
      else if (typeof value === 'number') tags.push(String(value))
    }
  }
  return [...new Set(tags)]
}

/** Nothing here may throw or return a wrong type: this feeds a validated IPC reply. */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function parseTopic(
  topic: TopicJson,
  postUrl: string,
  baseUrl: string,
  options: ScanOptions = {}
): ScrapedPost {
  const posts = topic.post_stream?.posts ?? []
  // The opening post is normally first, but say so explicitly.
  const first = posts.find((p) => p.post_number === 1) ?? posts[0] ?? {}
  const cooked = asString(first.cooked)
  // Discourse only sends `raw` when asked (fetchPost does). If it is missing
  // anyway, read the links out of the rendered HTML rather than returning a
  // post with no links at all — which is what silently happened until a real
  // post was tried: every external link in every post was invisible.
  const raw = asString(first.raw) || cookedToMarkdown(cooked)

  // One `seen` set across the whole thread: a reply that reposts the author's
  // own link adds nothing, and the author's copy is the one worth keeping.
  const seen = new Set<string>()
  const scan: ScanOptions = { ...options, seen }
  const replies = posts.filter((p) => p !== first)

  return {
    postId: typeof topic.id === 'number' ? topic.id : 0,
    postUrl,
    title: asString(topic.title),
    tags: normalizeTags(topic.tags),
    author: asString(first.username),
    createdAt: asString(topic.created_at),
    description: extractDescription(raw),
    previewImage: extractPreviewImage(cooked),
    links: [
      ...extractLinks(raw, cooked, baseUrl, scan),
      ...extractReplyLinks(replies, baseUrl, scan)
    ]
  }
}
