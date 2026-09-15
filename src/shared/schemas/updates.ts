import { z } from 'zod'

/**
 * App updates: which releases exist, where the updater is, and the notices
 * shown about them.
 *
 * Releases come from the project's GitHub releases. Each one carries a
 * Velopack feed for exactly one channel — `releases.win.json` for stable,
 * `releases.beta.json` for beta — so a release's channel is read from its
 * files rather than from GitHub's prerelease flag, which is only a label.
 */

export const UpdateChannelSchema = z.enum(['stable', 'beta'])

export const ReleaseSummarySchema = z.object({
  /** Semver without the tag's leading `v`. */
  version: z.string(),
  tag: z.string(),
  channel: UpdateChannelSchema,
  publishedAt: z.string().nullable(),
  /** The release's page on GitHub. */
  url: z.string(),
  /** Markdown, as written in the release. */
  notes: z.string()
})

export const UpdatePhaseSchema = z.enum([
  'idle',
  'checking',
  'upToDate',
  'available',
  'downloading',
  /** Downloaded; applying it means restarting the app. */
  'ready',
  'error'
])

export const UpdateStateSchema = z.object({
  phase: UpdatePhaseSchema,
  currentVersion: z.string(),
  /**
   * False when this copy was not installed by the updater — a development
   * run, or files copied by hand. Checking still works; installing does not.
   */
  supported: z.boolean(),
  /** The release being offered, downloaded or installed. */
  release: ReleaseSummarySchema.nullable(),
  /** Moving to an older version than the one running. */
  downgrade: z.boolean(),
  /** 0–100 while downloading. */
  progress: z.number().min(0).max(100).nullable(),
  /** An error code from APP_ERROR_CODES, while phase is `error`. */
  error: z.string().nullable(),
  /** The last check that reached GitHub, ISO time. */
  checkedAt: z.string().nullable(),
  /**
   * Ask the user: an automatic check found a release they have not skipped.
   * A check they started themselves shows its result where they started it.
   */
  prompt: z.boolean()
})

/** Text in every language the app ships; `en` is required and the fallback. */
export const LocalizedTextSchema = z
  .object({ en: z.string().min(1) })
  .catchall(z.string())

/**
 * One notice from `announcements.json` in the repository. Every targeting
 * field is optional: an entry with none reaches everyone, once.
 */
export const AnnouncementSchema = z.object({
  /** Stable and unique: a notice is shown once per id, per install. */
  id: z.string().min(1).max(100),
  publishedAt: z.string().optional(),
  /** Not shown after this time. */
  expiresAt: z.string().optional(),
  /** Only to versions at or above this one. */
  minVersion: z.string().optional(),
  /** Only to versions at or below this one. */
  maxVersion: z.string().optional(),
  /** Only to users following one of these channels. */
  channels: z.array(UpdateChannelSchema).optional(),
  title: LocalizedTextSchema,
  /** Markdown. */
  body: LocalizedTextSchema
})

/** What to show once the main window is up. */
export const StartupNoticesSchema = z.object({
  /** The app was just updated to this release; its notes say what changed. */
  whatsNew: z.object({ version: z.string(), notes: z.string() }).nullable(),
  announcements: z.array(AnnouncementSchema)
})

export type UpdateChannel = z.infer<typeof UpdateChannelSchema>
export type ReleaseSummary = z.infer<typeof ReleaseSummarySchema>
export type UpdatePhase = z.infer<typeof UpdatePhaseSchema>
export type UpdateState = z.infer<typeof UpdateStateSchema>
export type LocalizedText = z.infer<typeof LocalizedTextSchema>
export type Announcement = z.infer<typeof AnnouncementSchema>
export type StartupNotices = z.infer<typeof StartupNoticesSchema>
