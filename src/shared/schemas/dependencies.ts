import { z } from 'zod'

/**
 * External binaries the app installs and updates for the user:
 * yt-dlp for video-site downloads, ffmpeg for thumbnails and merging.
 */

export const BinaryIdSchema = z.enum(['ytdlp', 'ffmpeg'])

/** Where the binary in use came from — the UI offers "install" vs "update". */
export const BinarySourceSchema = z.enum(['configured', 'managed', 'path'])

export const BinaryStatusSchema = z.object({
  id: BinaryIdSchema,
  path: z.string().nullable(),
  source: BinarySourceSchema.nullable(),
  /** What it reports for `--version`; null when it will not run. */
  version: z.string().nullable(),
  /** Latest release, when GitHub could be reached. */
  latest: z.string().nullable(),
  /** Known to be behind — false whenever that cannot be established. */
  hasUpdate: z.boolean()
})

export const InstallProgressSchema = z.object({
  id: BinaryIdSchema,
  phase: z.enum(['downloading', 'extracting']),
  bytesDownloaded: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative().nullable()
})

export type BinaryId = z.infer<typeof BinaryIdSchema>
export type BinarySource = z.infer<typeof BinarySourceSchema>
export type BinaryStatus = z.infer<typeof BinaryStatusSchema>
export type InstallProgress = z.infer<typeof InstallProgressSchema>
