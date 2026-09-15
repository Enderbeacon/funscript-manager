import { fold } from './tokens'

/**
 * Who made the video, out of a forum post's title.
 *
 * The community names threads to a convention, and it holds well enough to be
 * worth reading: the animator's handle leads the title in brackets, or comes
 * before a dash, or trails a "by". What it is *not* is reliable enough to
 * trust blindly — the same bracket carries `(multi-axis)`, `[Announcement]`
 * and `(CS-PAID-0034)` — so every candidate has to survive a rejection pass
 * before it becomes a name on someone's library.
 *
 * Pure, and separated from scoring so it can be checked against a pile of real
 * titles without asking the forum anything.
 */

/** Bracket contents that are a label on the thread, not a person. */
const NOT_A_NAME = new Set([
  'multi-axis', 'multi axis', 'multiaxis', 'multi', 'axis', 'single axis', 'singleaxis',
  'soft', 'hardcore', 'suggested', 'hq', 'hq script', 'free', 'paid', 'update', 'updated',
  'request', 'requested', 'announcement', 'index', 'archive', 'collection', 'compilation',
  'script', 'scripts', 'funscript', 'funscripts', 'new', 'fixed', 'remake', 'reupload',
  'wip', 'preview', 'full', 'full version', 'teaser', 'trailer', 'beta', 'final',
  'sr6', 'osr2', 'ossm', 'handy', 'the handy', 'vr', 'non-vr', 'nonvr', '2d', '3d',
  'live2d', 'ani', '3axis', '4k', '8k', '60fps', 'pov', 'joi', 'asmr', 'mmd', 'sfm',
  'hentai', 'animation', 'game', 'real', 'cgi'
])

/** Words that give a bracket away as a label even inside a longer phrase. */
const LABEL_WORDS = /\b(script|scripts|axis|multi|update|request|announcement|index|version|release|edit|loop|patterns?|reward|exclusive|patreon|free|paid)\b/i

/** `CS-PAID-0034`, `RJ01070652` — a scripter's own catalogue number. */
const CATALOGUE = /^[a-z]{1,4}[-_ ]?(free|paid)?[-_ ]?\d{3,}$/i

const MIN_LENGTH = 2
const MAX_LENGTH = 40

function plausible(candidate: string, tagKeys: Set<string>): boolean {
  const name = candidate.trim()
  if (name.length < MIN_LENGTH || name.length > MAX_LENGTH) return false
  const key = fold(name)
  if (!key) return false
  if (NOT_A_NAME.has(key)) return false
  // The post's own tags are the cheapest possible check, and the one that
  // catches what a word list never would: `[Futanari] lewd game show` is a
  // genre in brackets, and the post is tagged `futanari` in so many words.
  if (tagKeys.has(key) || tagKeys.has(key.replace(/\s+/g, ''))) return false
  if (LABEL_WORDS.test(name)) return false
  if (CATALOGUE.test(name)) return false
  // A handle is a word or two. Longer than that and the bracket held a
  // description of the scene.
  if (key.split(' ').length > 3) return false
  // Pure punctuation or digits is never a name.
  if (!/[\p{L}]/u.test(name)) return false
  return true
}

/**
 * Candidates in the order the convention makes them likely, most explicit
 * first. Each is tried and dropped if it fails the rejection pass, so a title
 * that opens with `(multi-axis)` can still be read to the `by …` at its end.
 */
function candidatesOf(title: string): string[] {
  const out: string[] = []

  const leading = /^\s*[[(【（〔]\s*([^\])】）〕]{1,40})\s*[\])】）〕]/.exec(title)
  if (leading?.[1]) out.push(leading[1])

  // `MollyRedWolf - Elf Frieren …`, `Flim13 - Kitakami's …`
  const dashed = /^\s*([^-–—|:]{2,40}?)\s+[-–—]\s+\S/.exec(title)
  if (dashed?.[1]) out.push(dashed[1])

  // `… by pigtaro`, `… by ErenaRin (Full version)`
  const trailing = /\bby\s+([\p{L}\p{N}_@.'-]{2,40})/iu.exec(title)
  if (trailing?.[1]) out.push(trailing[1])

  return out
}

/**
 * The video's author, or empty when the title does not say plainly enough.
 *
 * `tags` is the post's own tag list; a bracket that repeats one of them is a
 * genre, not a person.
 */
export function videoAuthorFromTitle(title: string, tags: string[]): string {
  if (!title) return ''
  const tagKeys = new Set(tags.map((t) => fold(t.replace(/[-_]/g, ' '))))
  for (const tag of tags) tagKeys.add(fold(tag))
  for (const candidate of candidatesOf(title)) {
    const name = candidate.trim().replace(/[\s,]+$/, '')
    if (plausible(name, tagKeys)) return name
  }
  return ''
}
