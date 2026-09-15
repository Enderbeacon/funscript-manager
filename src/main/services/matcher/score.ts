import type { MatchEvidenceKind, MatchTier, PostCandidate } from '@shared/schemas/post-match'
import type { TopicHit } from '../scraper/discourse'
import { videoAuthorFromTitle } from './author'
import type { MatchSubject } from './query'
import { subjectNames } from './query'
import { fold, sameFolded, similarity, weigh } from './tokens'

/**
 * Deciding whether a search hit is the post an entry came from.
 *
 * Pure: a subject, a hit and what the query itself looked like go in, a scored
 * candidate comes out. Nothing here touches the network, so the thresholds can
 * be re-run over a whole library from a script without asking the forum again.
 *
 * The design rule is that `certain` is never a resemblance. It means a string
 * that is the same string — a funscript filename, or the title itself — with
 * nothing contradicting it. Everything that is merely a good likeness stops at
 * `likely` and waits to be looked at.
 */

export interface QueryContext {
  query: string
  /** How many topics that query returned. */
  hitCount: number
  /** The forum said there were more than it sent. */
  flooded: boolean
}

/** `len-5-10` and friends: the forum tags every scene with its length bracket. */
function lengthBracket(tags: string[]): { minMin: number; maxMin: number } | null {
  for (const tag of tags) {
    const range = /^len-(\d+)-(\d+)$/.exec(tag)
    if (range) return { minMin: Number(range[1]), maxMin: Number(range[2]) }
    const open = /^len-(\d+)(?:-plus|\+)$/.exec(tag)
    if (open) return { minMin: Number(open[1]), maxMin: Number.POSITIVE_INFINITY }
  }
  return null
}

/**
 * Funscript filenames mentioned in the search excerpt.
 *
 * Discourse renders an attachment as its short URL followed by the real
 * display name, so the text carries both `/uploads/short-url/s30q….funscript`
 * and `MollyRedWolf - … Feet.funscript (28.1 KB)`. Only the second is worth
 * anything, and it contains spaces, so this walks back from each extension
 * rather than matching a word.
 */
export function scriptNamesIn(text: string): string[] {
  const names: string[] = []
  const lower = text.toLowerCase()
  const marker = '.funscript'
  let at = lower.indexOf(marker)
  while (at !== -1) {
    const from = Math.max(0, at - 140)
    const head = text.slice(from, at)
    // Cut at what a filename cannot run through. Brackets are deliberately not
    // in this list: `(Author) Scene.funscript` is the single most common shape
    // a script on this forum has, and cutting at `(` decapitates it.
    const previous = head.toLowerCase().lastIndexOf(marker)
    const start = Math.max(
      previous === -1 ? -1 : previous + marker.length - 1,
      head.lastIndexOf('/'),
      head.lastIndexOf('\n'),
      head.lastIndexOf(':'),
      head.lastIndexOf('…')
    )
    const name = head.slice(start + 1).trim()
    // Short-url attachments are a content hash; they name nothing.
    if (name && name.length <= 140 && !/^[A-Za-z0-9_-]{20,}$/.test(name)) names.push(name)
    at = lower.indexOf(marker, at + marker.length)
  }
  return [...new Set(names)]
}

interface Scored {
  score: number
  tier: MatchTier
  evidence: { kind: MatchEvidenceKind; detail: string }[]
  scriptNames: string[]
}

/** A thread that answers every query because it is about ninety scripts at once. */
const INDEX_TITLE = /\b(index|collection|compilation|masterlist|master list|archive|all my|my scripts|script list|scripts list|megapack|pack)\b/i
const INDEX_POST_COUNT = 60
/** Past this many hits the query, not the result, was the problem. */
const FLOOD_HITS = 25

function evaluate(subject: MatchSubject, hit: TopicHit, context: QueryContext): Scored {
  const evidence: { kind: MatchEvidenceKind; detail: string }[] = []
  const names = subjectNames(subject)
  const localNames = [names.media, ...(names.title ? [names.title] : []), ...names.scripts]

  const postScripts = scriptNamesIn(`${hit.blurb}\n${hit.excerpt}`).map((n) =>
    n.replace(/\.funscript$/i, '')
  )

  // 1. The strongest cheap evidence there is: this post names the very file the
  //    entry already has. Old scripts came from this forum, and their filenames
  //    survived the trip.
  //
  //    Both tests run against filenames pulled out of the text, never against
  //    the text itself. A search excerpt is built around the terms that were
  //    searched for, so "the entry's name appears in the excerpt" is true of
  //    every hit for a query made of that name — it reads like evidence and is
  //    an echo of the question. That mistake had a winners announcement and an
  //    onahole review claiming to carry someone's script.
  let scriptExact = ''
  let scriptClose = ''
  for (const core of names.scripts) {
    const folded = fold(core)
    if (!folded || folded.length < 4) continue
    const named = postScripts.find((n) => sameFolded(n, core))
    if (named) {
      scriptExact = named
      break
    }
    if (scriptClose) continue
    // A variant label on one side or the other still identifies the file.
    const near = postScripts.find((n) => {
      const other = fold(n)
      if (other.length < 4) return false
      return other.startsWith(folded) || folded.startsWith(other)
    })
    if (near) scriptClose = near
  }
  if (scriptExact) evidence.push({ kind: 'script_name_exact', detail: scriptExact })
  else if (scriptClose) evidence.push({ kind: 'script_name_close', detail: scriptClose })

  // 2. Title likeness, measured against whichever local name does best.
  const remote = weigh(hit.title)
  let best = { score: 0, precision: 0, recall: 0, numberConflict: false }
  let exactTitle = false
  for (const name of localNames) {
    if (sameFolded(name, hit.title)) exactTitle = true
    const sim = similarity(weigh(name), remote)
    if (sim.score > best.score) best = sim
  }
  if (exactTitle) evidence.push({ kind: 'title_exact', detail: hit.title })
  else if (best.score >= 0.72) evidence.push({ kind: 'title_strong', detail: hit.title })
  else if (best.score >= 0.42) evidence.push({ kind: 'title_partial', detail: hit.title })

  // 3. Whoever posted it, or whoever the title credits the video to, showing up
  //    in the filename. Weak on its own, but it is what separates two scenes of
  //    the same character by different authors.
  //
  //    The credited name comes from the same reader the library uses, not from
  //    "the first word of the title" — that read `Sweetie Fox - …` as `Sweetie`
  //    and said so on screen.
  const foldedLocal = localNames.map(fold).join(' ')
  const credited = videoAuthorFromTitle(hit.title, hit.tags)
  const poster = fold(hit.username)
  let authorHit = ''
  if (poster.length >= 4 && foldedLocal.includes(poster)) authorHit = hit.username
  else if (credited && foldedLocal.includes(fold(credited))) authorHit = credited
  if (authorHit) evidence.push({ kind: 'author_match', detail: authorHit })

  // 4. The forum brackets every scene by length, and we know the real duration.
  //    Free corroboration, and a genuinely independent one — it has nothing to
  //    do with what anything is called.
  const bracket = lengthBracket(hit.tags)
  if (bracket && subject.durationMs && subject.durationMs > 0) {
    const minutes = subject.durationMs / 60000
    if (minutes >= bracket.minMin * 0.85 && minutes <= bracket.maxMin * 1.15) {
      evidence.push({ kind: 'duration_match', detail: `${Math.round(minutes)}` })
    } else {
      evidence.push({ kind: 'duration_conflict', detail: `${Math.round(minutes)}` })
    }
  }

  if (best.numberConflict && best.score >= 0.5) {
    evidence.push({ kind: 'number_conflict', detail: hit.title })
  }

  const indexThread = INDEX_TITLE.test(hit.title) || hit.postsCount >= INDEX_POST_COUNT
  if (indexThread) evidence.push({ kind: 'index_thread', detail: String(hit.postsCount) })

  const flooded = context.flooded || context.hitCount >= FLOOD_HITS
  if (flooded) evidence.push({ kind: 'flooded_query', detail: String(context.hitCount) })
  else if (context.hitCount === 1) evidence.push({ kind: 'sole_result', detail: '' })

  const has = (kind: MatchEvidenceKind): boolean => evidence.some((e) => e.kind === kind)

  let score = exactTitle ? Math.max(best.score, 0.9) : best.score
  if (scriptExact) score = Math.max(score, 0.95)
  else if (scriptClose) score += 0.2
  if (has('author_match')) score += 0.08
  if (has('duration_match')) score += 0.06
  // Softer than it looks damning: a length tag is set by hand, and a local file
  // can be a longer cut of the same scene. It still bars `certain` below.
  if (has('duration_conflict')) score -= 0.25
  if (has('number_conflict')) score -= 0.25
  if (has('sole_result')) score += 0.05
  if (indexThread) score -= 0.3
  if (flooded) score -= 0.1
  score = Math.max(0, Math.min(1, score))

  const contradicted = has('duration_conflict') || has('number_conflict') || indexThread
  // An exact title is only conclusive when the title actually says something.
  // "Ellen Joe (Zenless Zone Zero)" is a title several posts share.
  const titleIsDistinctive = remote.weight >= 2
  const ironclad = Boolean(scriptExact) || (exactTitle && titleIsDistinctive && !flooded)

  const tier: MatchTier = ironclad && !contradicted ? 'certain' : score >= 0.55 ? 'likely' : 'weak'

  return { score, tier, evidence, scriptNames: postScripts }
}

export function scoreHit(
  subject: MatchSubject,
  hit: TopicHit,
  context: QueryContext
): Omit<PostCandidate, 'alreadyLinked'> {
  const { score, tier, evidence, scriptNames } = evaluate(subject, hit, context)
  return {
    topicId: hit.topicId,
    url: hit.url,
    title: hit.title,
    tags: hit.tags,
    author: hit.username,
    postsCount: hit.postsCount,
    createdAt: hit.createdAt,
    thumbnailUrl: hit.thumbnailUrl,
    scriptNames,
    score,
    tier,
    evidence,
    query: context.query
  }
}
