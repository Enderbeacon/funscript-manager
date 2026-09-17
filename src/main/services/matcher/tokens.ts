/**
 * Turning names into comparable words, for post matching.
 *
 * Pure string work, no I/O, so the whole scoring layer can be exercised
 * against a real library offline.
 */

/** Lower-cased, every run of separators reduced to one space. */
export function fold(value: string): string {
  return value
    .replace(/[\s._\-–—/\\|,;:!?"'`~+*=&#@()[\]{}【】（）〔〕「」『』]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

// Kana, CJK ideographs (incl. extension A and compatibility), Hangul.
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/

/**
 * Words as a person would separate them — no bigrams.
 *
 * The bigram treatment below exists so that two spellings of a CJK title still
 * overlap when they are *compared*. Sending bigrams to the forum as a *query*
 * is the opposite of useful: a ten-character Japanese title turns into nine
 * two-character fragments that match half the forum. Anything building a query
 * uses this; only scoring uses `tokenize`.
 */
export function words(value: string): string[] {
  return fold(value).split(' ').filter(Boolean)
}

/**
 * Words, with CJK handled as bigrams.
 *
 * Splitting on spaces is meaningless for Japanese and Chinese titles, and this
 * library has plenty of them. A run of CJK characters becomes its overlapping
 * two-character pairs, which is enough for two spellings of the same title to
 * overlap without pulling in a dictionary.
 */
export function tokenize(value: string): string[] {
  const out: string[] = []
  for (const chunk of fold(value).split(' ')) {
    if (!chunk) continue
    if (!CJK.test(chunk)) {
      out.push(chunk)
      continue
    }
    // Mixed runs (`【JOI】トレーニング`) split into their CJK and non-CJK stretches.
    for (const part of chunk.split(/([\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+)/)) {
      if (!part) continue
      if (!CJK.test(part)) {
        out.push(part)
        continue
      }
      if (part.length <= 2) {
        out.push(part)
        continue
      }
      for (let i = 0; i + 2 <= part.length; i++) out.push(part.slice(i, i + 2))
    }
  }
  return out
}

/**
 * Words that say nothing about which scene this is.
 *
 * Two groups, and they are noise for different reasons. Encoding and release
 * furniture is noise because it describes the file; the forum's own tag
 * vocabulary is noise because it describes half the forum — a title sharing
 * `blowjob` with another title is not evidence of anything.
 */
const FILE_NOISE = new Set([
  '1080p', '720p', '480p', '1440p', '2160p', '2880p', '4320p',
  '2k', '4k', '5k', '6k', '8k', 'hd', 'fhd', 'uhd', 'hq', 'sd',
  'h264', 'h265', 'x264', 'x265', 'hevc', 'avc', 'av1', 'aac', 'mp3',
  'mp4', 'mkv', 'wmv', 'avi', 'mov', 'm4v', 'webm', 'funscript',
  'sbs', 'tb', 'ou', 'lr', 'mono', 'fisheye', 'mkx200', 'mkx220', 'vrca220',
  'rf52', '180', '360', '190', '200', '220', '3dh', '3dv', '3d', '2d',
  'vr', 'nonvr', 'oculus', 'quest', 'smartphone', 'original', 'remux',
  'final', 'fixed', 'version', 'ver', 'part', 'full', 'complete', 'edit',
  'com', 'net', 'org', 'www', 'xxx', 'tv', 'me'
])

const FORUM_VOCAB = new Set([
  'pov', 'real', 'animation', 'animated', 'hentai', 'cgi', 'game', 'cosplay',
  'blowjob', 'handjob', 'footjob', 'titjob', 'creampie', 'cumshot', 'facial',
  'doggy', 'cowgirl', 'missionary', 'riding', 'ride', 'anal', 'vaginal',
  'threesome', 'femdom', 'joi', 'asmr', 'milf', 'teen', 'solo', 'lesbian',
  'straight', 'futanari', 'succubus', 'x', 'ray', 'multi', 'axis', 'script',
  'scripts', 'funscripts', 'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on',
  'to', 'for', 'with', 'her', 'his', 'you', 'your', 'my', 'me', 'it'
])

/** Sites the filename may have been named after; never a distinguishing word. */
const SITE_NAMES = new Set([
  'pornhub', 'xvideos', 'xnxx', 'xhamster', 'spankbang', 'eporner', 'rule34video',
  'hanime1', 'iwara', 'youtube', 'twitter', 'reddit', 'onlyfans', 'fansly',
  'patreon', 'eroscripts', 'pixeldrain', 'mega', 'gofile'
])

export function isFileNoise(token: string): boolean {
  return FILE_NOISE.has(token) || SITE_NAMES.has(token) || /^\d{3,4}p$/.test(token)
}

/**
 * How much a shared word is worth.
 *
 * Without the forum's whole title corpus there is no real IDF to compute, so
 * this stands in for it: file furniture is worth nothing, the vocabulary every
 * second thread uses is worth little, and an unusual word — a character name,
 * an author handle, a series — carries the match. A word that mixes letters
 * and digits (`2b`, `ellesclub3`) is treated as unusual on purpose; those are
 * almost always names.
 */
export function weightOf(token: string): number {
  if (isFileNoise(token)) return 0
  if (FORUM_VOCAB.has(token)) return 0.15
  if (/^\d+$/.test(token)) return 0.35
  if (token.length <= 2) return 0.3
  if (/\d/.test(token) && /[a-z]/.test(token)) return 1.4
  if (token.length >= 8) return 1.2
  return 1
}

export interface WeightedTokens {
  tokens: string[]
  /** Deduplicated, noise dropped — what similarity is actually measured over. */
  set: Set<string>
  weight: number
  /** Bare numbers, kept apart: they decide episodes, not subjects. */
  numbers: Set<string>
}

export function weigh(value: string): WeightedTokens {
  const tokens = tokenize(value)
  const set = new Set<string>()
  const numbers = new Set<string>()
  let weight = 0
  for (const token of tokens) {
    if (isFileNoise(token)) continue
    if (/^\d+$/.test(token)) {
      // A bare year or a resolution-ish number is not an episode number.
      if (token.length <= 3 && Number(token) > 0) numbers.add(token)
      continue
    }
    if (set.has(token)) continue
    set.add(token)
    weight += weightOf(token)
  }
  return { tokens, set, weight, numbers }
}

export interface Similarity {
  /** How much of the entry's name the post's title accounts for. */
  precision: number
  /** How much of the post's title the entry's name accounts for. */
  recall: number
  score: number
  /** Both sides carry numbers and none of them agree. */
  numberConflict: boolean
}

/**
 * Weighted overlap between an entry's name and a post's title.
 *
 * Recall is worth more than precision because the two sides are not
 * symmetrical: a filename routinely carries a comma-separated tag run and a
 * site name the title never had, while a title that shares nothing with the
 * filename is simply a different scene. Punishing the extra baggage on the
 * local side would demote the matches that actually work.
 */
export function similarity(local: WeightedTokens, remote: WeightedTokens): Similarity {
  if (local.weight === 0 || remote.weight === 0) {
    return { precision: 0, recall: 0, score: 0, numberConflict: false }
  }
  let shared = 0
  for (const token of local.set) {
    if (remote.set.has(token)) shared += weightOf(token)
  }
  const precision = shared / local.weight
  const recall = shared / remote.weight
  const numberConflict =
    local.numbers.size > 0 &&
    remote.numbers.size > 0 &&
    [...local.numbers].every((n) => !remote.numbers.has(n))
  return { precision, recall, score: 0.4 * precision + 0.6 * recall, numberConflict }
}

/** Same string once separators and case stop mattering. */
export function sameFolded(a: string, b: string): boolean {
  const x = fold(a)
  const y = fold(b)
  return x.length > 0 && x === y
}
