import type { PostCandidate, PostMatchResult } from '@shared/schemas/post-match'
import { findByTopicId, getMediaDetail } from '../library/library-manager'
import { searchTopics, type TopicHit } from '../scraper/discourse'
import { planQueries, type MatchSubject } from './query'
import { scoreHit } from './score'

/**
 * Finding the forum post behind an entry that has none.
 *
 * Runs the query ladder against the forum's search, scores everything that
 * comes back, and stops the moment something is conclusive. Stopping early is
 * the point: a search is the one forum request that is not served from cache,
 * and most entries are answered by the first rung — their own filename.
 */

/** A ceiling on how many requests one entry may cost, however many rungs exist. */
const MAX_QUERIES = 4
/** Beyond this the list stops being a shortlist. */
const MAX_CANDIDATES = 8
/** Below this a hit is noise; it is not worth a row on screen. */
const MIN_SCORE = 0.2

function subjectOf(detail: {
  fileName: string
  title: string | null
  durationMs: number | null
  scriptVersions: { files: string[] }[]
}): MatchSubject {
  return {
    fileName: detail.fileName,
    title: detail.title,
    scriptFiles: detail.scriptVersions.flatMap((v) => v.files),
    durationMs: detail.durationMs
  }
}

/**
 * Search for the post an entry came from.
 *
 * `overrideQuery` replaces the whole ladder with one query — the manual path,
 * for when the user can see at a glance what should have been asked and the
 * cleaning rules got in the way.
 */
export async function findPostForMedia(
  libraryId: string,
  mediaId: string,
  overrideQuery?: string
): Promise<PostMatchResult> {
  const detail = await getMediaDetail(libraryId, mediaId)
  if (!detail) return { queriesTried: [], candidates: [] }

  const subject = subjectOf(detail)
  const planned = overrideQuery?.trim()
    ? [{ query: overrideQuery.trim(), rung: 'file' as const }]
    : planQueries(subject).slice(0, MAX_QUERIES)

  const queriesTried: { query: string; hits: number }[] = []
  /** Best scoring of a topic wins: the same post can answer several rungs. */
  const byTopic = new Map<number, PostCandidate>()
  const seenHits = new Map<number, TopicHit>()

  for (const { query } of planned) {
    const result = await searchTopics(query)
    queriesTried.push({ query, hits: result.hits.length })

    for (const hit of result.hits) {
      seenHits.set(hit.topicId, hit)
      const scored = scoreHit(subject, hit, {
        query,
        hitCount: result.hits.length,
        flooded: result.more
      })
      const existing = byTopic.get(hit.topicId)
      if (existing && existing.score >= scored.score) continue
      byTopic.set(hit.topicId, { ...scored, alreadyLinked: false })
    }

    // Conclusive evidence ends the ladder; the remaining rungs would only cost
    // requests to re-find the same post.
    if ([...byTopic.values()].some((c) => c.tier === 'certain')) break
  }

  const ranked = [...byTopic.values()]
    .filter((c) => c.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES)

  /**
   * Two conclusive answers are no answer.
   *
   * A popular animation gets scripted by three people, each naming their
   * funscript after the source video, so all three posts carry a filename that
   * is the entry's filename. Every one of them is `certain` on its own
   * evidence and at most one of them is where this copy came from. Since
   * `certain` is the tier that may be applied without being asked, ambiguity
   * has to cancel it rather than pick a winner by score — the scores in this
   * situation are identical anyway.
   */
  const contested = ranked.filter((c) => c.tier === 'certain').length > 1
  const candidates = ranked
    .map((c) => (contested && c.tier === 'certain' ? { ...c, tier: 'likely' as const } : c))
    .map((c) => {
      const linked = findByTopicId(c.topicId)
      return {
        ...c,
        alreadyLinked: linked !== null && linked.mediaId !== mediaId
      }
    })

  return { queriesTried, candidates }
}
