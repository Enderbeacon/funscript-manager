import { z } from 'zod'

/**
 * Renderer-facing projections of the index layer (derived cache).
 * These cross IPC; they are views over index.db, never sources of truth.
 */

export const MediaListItemSchema = z.object({
  id: z.uuid(),
  /** Owning library; media lists aggregate across libraries by default. */
  libraryId: z.uuid(),
  /** Path relative to the library root, forward slashes. */
  filePath: z.string(),
  fileName: z.string(),
  title: z.string().nullable(),
  fileSize: z.number().int().nonnegative().nullable(),
  /** File referenced by the sidecar/index no longer exists on disk. */
  missing: z.boolean(),
  /** The file has never arrived — bought elsewhere, still to be supplied. */
  wanted: z.boolean().default(false),
  tags: z.array(z.string()),
  rating: z.number().int().min(0).max(5).nullable().default(null),
  favorite: z.boolean().default(false),
  durationMs: z.number().int().nonnegative().nullable().default(null),
  scriptVersionCount: z.number().int().nonnegative(),
  hasMultiAxis: z.boolean(),
  subtitleLanguages: z.array(z.string()),
  /**
   * The two times the grid can sort by, epoch ms: when the entry's files
   * arrived here, and when one of them (or the entry itself) last changed.
   *
   * Carried on the row for the same reason playlistRank is — a list can span
   * several libraries, and no single index can order across them.
   */
  addedAt: z.number().nullable().default(null),
  modifiedAt: z.number().nullable().default(null),
  /**
   * Where this row sits in the playlist being ordered by, when the list is
   * sorted that way. Null both for "not sorting by a playlist" and for "in it
   * but never given a place"; the second sorts last, after everything ranked.
   *
   * Carried on the row because SQL cannot order across two libraries' indexes —
   * a playlist spans all of them, so the merge has to redo the comparison.
   */
  playlistRank: z.string().nullable().default(null)
})

export const MediaListPageSchema = z.object({
  items: z.array(MediaListItemSchema),
  total: z.number().int().nonnegative()
})

/** One script version, projected for the detail page (files → axis keys). */
export const ScriptVersionInfoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  author: z.string().nullable(),
  isDefault: z.boolean(),
  isMultiAxis: z.boolean(),
  /** Canonical axis order (main, roll, pitch, surge, sway, twist). */
  axes: z.array(z.string()),
  /** Script file names, relative to the media file's folder (delete confirm). */
  files: z.array(z.string()),
  /** Single-axis version with a multi-axis version available to borrow from. */
  canInheritAxes: z.boolean(),
  /** Borrowing is on (only meaningful when canInheritAxes). */
  inheritAxes: z.boolean(),
  /** Axes this version borrows right now, canonical order. */
  borrowedAxes: z.array(z.string()),
  /** Name of the multi-axis version being borrowed from, if any. */
  inheritedFrom: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  notes: z.string().nullable()
})

/**
 * Full single-media projection for the detail page. Built fresh from the
 * sidecar (source of truth), not the index — the index only summarizes.
 */
export const MediaDetailSchema = z.object({
  id: z.uuid(),
  libraryId: z.uuid(),
  filePath: z.string(),
  fileName: z.string(),
  title: z.string().nullable(),
  fileSize: z.number().int().nonnegative().nullable(),
  /** Absolute path, for the reveal-in-folder action and for showing where it lives. */
  absPath: z.string().default(''),
  createdAt: z.string().nullable().default(null),
  durationMs: z.number().int().nonnegative().nullable().default(null),
  resolution: z.string().nullable().default(null),
  codec: z.string().nullable().default(null),
  /** Head hash from the sidecar; empty for an entry whose file never arrived. */
  fingerprint: z.string().default(''),
  missing: z.boolean(),
  /**
   * Set while the media file has not arrived. Carries where it has to be got
   * from, so the detail page can link out instead of only saying it is absent.
   */
  wanted: z
    .object({ sources: z.array(z.object({ url: z.string(), hoster: z.string(), label: z.string() })) })
    .nullable()
    .default(null),
  tags: z.array(z.string()),
  videoAuthors: z.array(z.string()).default([]),
  scriptAuthors: z.array(z.string()).default([]),
  studios: z.array(z.string()).default([]),
  playlists: z.array(z.string()).default([]),
  scriptVersions: z.array(ScriptVersionInfoSchema),
  subtitles: z.array(z.object({ language: z.string().nullable(), path: z.string() })),
  /** Same three kinds the sidecar stores; the panel edits this list directly. */
  sources: z.array(z.object({ type: z.enum(['eroscripts', 'original', 'other']), url: z.string() })),
  /**
   * Links the post carried that the app cannot fetch. Read-only here: the only
   * thing to do with one is open it, so the panel shows them folded away at the
   * bottom rather than mixed into the sources the user maintains.
   */
  postLinks: z
    .array(z.object({ url: z.string(), hoster: z.string(), label: z.string() }))
    .default([]),
  lastUsedScriptVersionId: z.uuid().nullable(),
  favorite: z.boolean(),
  rating: z.number().int().min(0).max(5).nullable(),
  notes: z.string().nullable()
})

export const SyncPhaseSchema = z.enum(['listing', 'sidecars', 'media', 'cleanup', 'done'])

export const SyncProgressSchema = z.object({
  libraryId: z.uuid(),
  phase: SyncPhaseSchema,
  processed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative()
})

export type MediaListItem = z.infer<typeof MediaListItemSchema>
export type MediaListPage = z.infer<typeof MediaListPageSchema>
export type ScriptVersionInfo = z.infer<typeof ScriptVersionInfoSchema>
export type MediaDetail = z.infer<typeof MediaDetailSchema>
export type SyncPhase = z.infer<typeof SyncPhaseSchema>
export type SyncProgress = z.infer<typeof SyncProgressSchema>
