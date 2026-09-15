import { z } from 'zod'

/**
 * Finding the forum post an old library entry came from.
 *
 * The app searches the forum with the entry's own names and scores what comes
 * back. Everything here crosses IPC, so evidence is carried as codes and
 * parameters — the reasons are written in the renderer's locale bundle, never
 * in the main process.
 */

/**
 * Why a candidate scored the way it did. Negative kinds are carried too: the
 * panel has to be able to say "this is the only hit, but it is an index thread
 * covering ninety scripts", which is the difference between a match and a trap.
 */
export const MATCH_EVIDENCE_KINDS = [
  /** A funscript named in the post is the entry's own script filename. */
  'script_name_exact',
  /** …or close enough that only a variant label separates them. */
  'script_name_close',
  /** Post title and the entry's name are the same string once folded. */
  'title_exact',
  /** Most of the distinctive words in both names are shared. */
  'title_strong',
  'title_partial',
  /** Whoever posted, or the name the title leads with, appears in the filename. */
  'author_match',
  /** The post's length tag agrees with the file's real duration. */
  'duration_match',
  /** …or contradicts it. */
  'duration_conflict',
  /** The words match but the numbers do not — the usual shape of a wrong episode. */
  'number_conflict',
  /** The only thing the forum returned for that query. */
  'sole_result',
  /** A long-running index or collection thread; it matches everything. */
  'index_thread',
  /** The query was too broad to mean anything on its own. */
  'flooded_query'
] as const

export type MatchEvidenceKind = (typeof MATCH_EVIDENCE_KINDS)[number]

export const MatchEvidenceSchema = z.object({
  kind: z.enum(MATCH_EVIDENCE_KINDS),
  /** Filled into the translated reason, e.g. the matched script's filename. */
  detail: z.string().default('')
})

/**
 * How far the app is willing to go on its own.
 *
 * `certain` is reserved for evidence that is not a resemblance — a script
 * filename that is the same string, a title that is the same string. Only that
 * tier is ever applied without being asked.
 */
export const MATCH_TIERS = ['certain', 'likely', 'weak'] as const
export type MatchTier = (typeof MATCH_TIERS)[number]

export const PostCandidateSchema = z.object({
  topicId: z.number().int().positive(),
  url: z.string(),
  title: z.string(),
  tags: z.array(z.string()),
  /** Who posted it — the script's author, which the title's name often is not. */
  author: z.string(),
  postsCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  /** Forum-hosted preview; the renderer fetches it through `scrape:remoteImage`. */
  thumbnailUrl: z.string(),
  /** Funscript filenames spotted in the search excerpt, when it happened to carry any. */
  scriptNames: z.array(z.string()),
  score: z.number(),
  tier: z.enum(MATCH_TIERS),
  evidence: z.array(MatchEvidenceSchema),
  /** The query that turned this up, so a bad result can be re-asked by hand. */
  query: z.string(),
  /** This post is already recorded as a source on some entry in the library. */
  alreadyLinked: z.boolean().default(false)
})

export type PostCandidate = z.infer<typeof PostCandidateSchema>

export const PostMatchResultSchema = z.object({
  /** Every query actually sent, in order, with what each one cost in results. */
  queriesTried: z.array(z.object({ query: z.string(), hits: z.number().int().nonnegative() })),
  candidates: z.array(PostCandidateSchema)
})

export type PostMatchResult = z.infer<typeof PostMatchResultSchema>

/**
 * How a library-wide pass is getting on.
 *
 * `error` is a code, not a sentence — a run stops on a dead session or a rate
 * limit, and the renderer says which in the user's own language.
 */
export const MatchScanStatusSchema = z.object({
  running: z.boolean(),
  paused: z.boolean(),
  total: z.number().int().nonnegative(),
  scanned: z.number().int().nonnegative(),
  /** Resolved outright, without asking. */
  applied: z.number().int().nonnegative(),
  /** Waiting to be looked at. */
  queued: z.number().int().nonnegative(),
  none: z.number().int().nonnegative(),
  currentPath: z.string(),
  error: z.string().nullable()
})

export type MatchScanStatus = z.infer<typeof MatchScanStatusSchema>

/** One row of the review queue: the entry, and what the forum offered for it. */
export const MatchQueueItemSchema = z.object({
  libraryId: z.uuid(),
  mediaId: z.uuid(),
  filePath: z.string(),
  fileName: z.string(),
  candidates: z.array(PostCandidateSchema)
})

export type MatchQueueItem = z.infer<typeof MatchQueueItemSchema>
