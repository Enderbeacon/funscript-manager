import { z } from 'zod'

/**
 * Download queue projections. Unlike media, these are NOT derived
 * from anything on disk: the job list is its own source of truth, which is why
 * it lives in `<userData>/downloads.db` rather than a library's disposable
 * index.db.
 */

export const DownloadStateSchema = z.enum([
  'pending',
  'running',
  'paused',
  /** Parked until a host's quota window reopens; resumes on its own. */
  'cooling',
  'failed',
  'done'
])

export const DownloadJobSchema = z.object({
  id: z.uuid(),
  /** The page/source URL — never a resolved direct link, which expires. */
  sourceUrl: z.string(),
  /** Plugin id that claimed the URL. */
  hoster: z.string(),
  /** Library the finished file is moved into. */
  libraryId: z.uuid(),
  /** Best known filename; may be refined once the download starts. */
  fileName: z.string(),
  state: DownloadStateSchema,
  bytesDownloaded: z.number().int().nonnegative(),
  /** null until the server reports a length. */
  totalBytes: z.number().int().nonnegative().nullable(),
  /** Error code or message shown on a failed job. */
  error: z.string().nullable(),
  /** Retries already spent on the current attempt chain. */
  attempts: z.number().int().nonnegative(),
  /** Absolute path of the finished file (set when done). */
  filePath: z.string().nullable(),
  /** Jobs enqueued together from one forum post share this; null for a plain link. */
  batchId: z.uuid().nullable(),
  /** What this file is to the post it came from. */
  role: z.enum(['video', 'script', 'other']),
  /** Library path of an identical media already indexed, found after ingest. */
  duplicateOf: z.string().nullable(),
  /** When a cooling job will try again; null unless it is cooling. */
  cooldownUntil: z.iso.datetime().nullable(),
  /**
   * The post this job came from, read back out of the stored ScrapedPost so
   * the queue can say what a file belongs to. Empty for a plain link — and
   * for jobs queued before the post was recorded.
   */
  postTitle: z.string().default(''),
  postUrl: z.string().default(''),
  /** Poster frame from the post, used as the row's thumbnail. */
  postThumb: z.string().default(''),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
})

/** Live rate for a running job; batched into one event at 4 Hz. */
export const DownloadProgressSchema = z.object({
  id: z.uuid(),
  bytesDownloaded: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative().nullable(),
  speedBytesPerSec: z.number().nonnegative(),
  etaSec: z.number().nonnegative().nullable()
})

export type DownloadState = z.infer<typeof DownloadStateSchema>
export type DownloadJob = z.infer<typeof DownloadJobSchema>
export type DownloadProgress = z.infer<typeof DownloadProgressSchema>
