import { z } from 'zod'
import { FUNSCRIPT_EXTENSION } from '../constants'
import { VrFormatSchema } from './vr-video'

/**
 * Sidecar (`<full media filename>.meta.json`) schema.
 * The sidecar is the single source of truth: every write lands in the
 * sidecar first; index.db is only a derived cache.
 */

export const FileFingerprintSchema = z.looseObject({
  size: z.number().int().nonnegative(),
  /** BLAKE3 hash (hex) of the first 1MB of the file. */
  blake3Head: z.string()
})

export const SourceSchema = z.looseObject({
  type: z.enum(['eroscripts', 'original', 'other']),
  url: z.url(),
  fetchedAt: z.iso.datetime().optional()
})

export const SCRIPT_AXIS_KEYS = ['main', 'roll', 'pitch', 'surge', 'sway', 'twist'] as const

/**
 * Axis → script file path map within one script version.
 * Paths are relative to the sidecar's directory; `..` escaping the library
 * root is rejected at write time.
 */
export const ScriptFilesSchema = z
  .partialRecord(z.enum(SCRIPT_AXIS_KEYS), z.string())
  .refine((files) => files.main !== undefined, {
    message: 'script version must have a main axis file'
  })

export const ScriptVersionSchema = z.looseObject({
  id: z.uuid(),
  name: z.string().min(1),
  author: z.string().optional(),
  sourceUrl: z.url().optional(),
  isDefault: z.boolean().optional(),
  notes: z.string().optional(),
  /**
   * Single-axis versions only: also drive the axes this version has no script
   * for, borrowing them from the media's default multi-axis version. Absent =
   * borrow, which is what most people expect from a main-axis-only script.
   */
  inheritAxes: z.boolean().optional(),
  files: ScriptFilesSchema
})

export const SubtitleSchema = z.looseObject({
  /** BCP 47 language code; unrecognized markers are kept verbatim; undefined = no marker. */
  language: z.string().optional(),
  path: z.string()
})

/**
 * What the file itself says, read once with ffmpeg and kept in the sidecar.
 * It lives here rather than only in the index because probing thousands of files is the expensive part of a rebuild, and the index
 * is meant to be disposable.
 *
 * Every field is optional: an audio file has no frame size, and a file ffmpeg
 * cannot read has none of it. Absent means "not known", never zero.
 */
export const MediaInfoSchema = z.looseObject({
  durationMs: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  videoCodec: z.string().optional(),
  audioCodec: z.string().optional()
})

export const UserMetaSchema = z.looseObject({
  rating: z.number().int().min(0).max(5).optional(),
  favorite: z.boolean().optional(),
  notes: z.string().optional(),
  lastPlayed: z.iso.datetime().optional(),
  lastUsedScriptVersionId: z.uuid().optional()
})

/**
 * Set while the media file itself has not arrived. The post's scripts, tags
 * and source are already filed; only the video is outstanding, because it sits
 * behind a purchase or a site we cannot fetch from.
 *
 * Presence of this block is what separates "never downloaded" from "the file
 * used to be here and is gone" — the index marks both as missing, but only one
 * of them is something the user can act on.
 */
export const WantedSchema = z.looseObject({
  /** Where the file has to be got from; shown as links out, never as downloads. */
  sources: z
    .array(z.looseObject({ url: z.string(), hoster: z.string(), label: z.string() }))
    .default([]),
  /**
   * Media the user has told us are NOT this entry, when the app offered them as
   * a name match. Without it the same wrong guess comes back on every visit.
   */
  dismissed: z.array(z.uuid()).default([]),
  addedAt: z.iso.datetime()
})

/**
 * What a search for this entry's forum post has already established.
 *
 * This is the one part of matching that belongs in the sidecar. The candidates
 * and their scores are derived — throw them away and another run rebuilds them
 * — but "I looked" and "that one is not it" are judgements, the user's or the
 * app's, and nothing can reconstruct them.
 */
export const PostMatchSchema = z.looseObject({
  /** Last time the forum was searched for this entry. */
  checkedAt: z.iso.datetime(),
  /** Topic ids the user has said are not this entry; never offered again. */
  dismissed: z.array(z.number().int()).default([]),
  /**
   * The topic the app attached by itself, without being asked.
   *
   * Recorded so that a run made under a rule that turns out to be wrong can be
   * found and undone. Without it an automatic link is indistinguishable from
   * one the user chose, and "undo what the computer decided" stops being
   * possible the moment it matters.
   */
  auto: z.number().int().optional()
})

/**
 * The name lists a media carries. All four are plain names, not ids, for the
 * same reason tags always were: a sidecar that loses its companion definition
 * file is still readable, and a name is what the user typed anyway. Structure
 * (tag parents, aliases, descriptions) lives in taxonomy.json and adds to
 * these without owning them.
 *
 * `videoAuthors` replaced `performers` in v2: plenty of the library is 3D or
 * animated and has nobody performing in it, but everything has somebody who
 * made it.
 */
/**
 * The version every sidecar this app writes carries.
 *
 * Named rather than spelled out at each construction site: the last bump left
 * one builder writing the previous number, and since the schema takes a
 * literal, every newly discovered media file failed to be filed at all.
 * Bumping is this constant plus one more step in the upgrade chain below.
 */
export const MEDIA_META_VERSION = 3

export const MediaMetaSchema = z.looseObject({
  schemaVersion: z.literal(MEDIA_META_VERSION),
  /** Stable app-assigned UUID; survives file renames and moves. */
  id: z.uuid(),
  fileFingerprint: FileFingerprintSchema,
  /** Read from the file with ffmpeg; absent until it has been probed. */
  mediaInfo: MediaInfoSchema.optional(),
  /**
   * How the user marked this file: a VR format, or `flat` for "not VR".
   * Absent when it has not been marked; it then plays as a flat video.
   * A value that does not parse is dropped rather than failing the sidecar.
   */
  vr: VrFormatSchema.optional().catch(undefined),
  /** Present until the media file is supplied; see WantedSchema. */
  wanted: WantedSchema.optional(),
  /** Set once the forum has been searched for this entry; see PostMatchSchema. */
  postMatch: PostMatchSchema.optional(),
  title: z.string().optional(),
  tags: z.array(z.string()).default([]),
  /** Whoever made the video. */
  videoAuthors: z.array(z.string()).default([]),
  /** Whoever made the scripts; rarely the same people. */
  scriptAuthors: z.array(z.string()).default([]),
  studios: z.array(z.string()).default([]),
  /** Playlist names this media belongs to. Membership only — see below. */
  playlists: z.array(z.string()).default([]),
  /**
   * Where this media sits inside each playlist it belongs to, as playlist name
   * → ordering key (see shared/rank.ts).
   *
   * Kept beside `playlists` rather than folded into it, so that a playlist
   * stays an ordinary name list: filtering by one, renaming one, giving one a
   * cover image all keep working through the same machinery as tags, and
   * membership survives on its own. A missing key is a legitimate state — it
   * means this list has never been put in an order — and such a list falls
   * back to path order, which is what it looked like as a v2 collection.
   *
   * Order belongs to the list, not to the media: the same video is third in
   * one playlist and tenth in another, which is why this is a map and not a
   * number on the media.
   */
  playlistRanks: z.record(z.string(), z.string()).default({}),
  sources: z.array(SourceSchema).default([]),
  /**
   * Links the post carried that the app has no downloader for — a store page,
   * a Patreon, someone's personal host. Kept apart from `sources`, which is
   * where this media came from: these are places it can *also* be got, and the
   * only thing to do with them is open one.
   *
   * Worth keeping rather than dropping at parse time, because they are usually
   * the higher-quality or paid version, and a year later the post may be gone
   * while the sidecar is still here.
   */
  postLinks: z
    .array(z.looseObject({ url: z.string(), hoster: z.string().default(''), label: z.string().default('') }))
    .default([]),
  scriptVersions: z.array(ScriptVersionSchema).default([]),
  subtitles: z.array(SubtitleSchema).default([]),
  userMeta: UserMetaSchema.prefault({}),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime()
})

/** The name lists, as one shape — everything batch editing and the index touch. */
export const NAME_FIELDS = ['tags', 'videoAuthors', 'scriptAuthors', 'studios', 'playlists'] as const
export type NameField = (typeof NAME_FIELDS)[number]


/**
 * Sidecars written before the rename. Upgrading on read (rather than a pass
 * over the library) means an untouched file keeps working and only gets
 * rewritten when something else changes it.
 */
function upgradeV1(raw: Record<string, unknown>): Record<string, unknown> {
  const { performers, studio, ...rest } = raw
  return {
    ...rest,
    schemaVersion: 2,
    videoAuthors: Array.isArray(performers) ? performers : [],
    scriptAuthors: [],
    studios: typeof studio === 'string' && studio ? [studio] : [],
    collections: []
  }
}

/**
 * v2's `collections` became v3's `playlists`: the same grouping, now with an
 * order the user controls.
 *
 * No ranks are handed out here. A sidecar can only see its own media, so every
 * one of them would independently pick the same key and the list would be no
 * more ordered than before — just lying about it. Left empty, the playlist
 * reads as "never ordered" and shows in path order, exactly as the collection
 * did; the first drag materialises real keys for that one list.
 */
function upgradeV2(raw: Record<string, unknown>): Record<string, unknown> {
  const { collections, ...rest } = raw
  return {
    ...rest,
    schemaVersion: 3,
    playlists: Array.isArray(collections) ? collections : [],
    playlistRanks: {}
  }
}

/**
 * Early sidecars and the download flow used the literal word "Default" as the
 * version name when a script had no variant label. That is meaningless in a
 * library where nearly every entry has one. Rename it to the script file's own
 * base name on read; the corrected value persists the next time the sidecar is
 * written back.
 */
function normalizeDefaultVersionNames(raw: Record<string, unknown>): void {
  const versions = raw.scriptVersions
  if (!Array.isArray(versions)) return
  for (const v of versions) {
    if (!v || typeof v !== 'object') continue
    const ver = v as Record<string, unknown>
    if (ver.name !== 'Default') continue
    const files = ver.files
    if (!files || typeof files !== 'object') continue
    const main = (files as Record<string, unknown>).main
    if (typeof main !== 'string') continue
    // Same logic as scriptVersionName in companion-grouping.ts, inlined here
    // because this module is shared code and must not import from main/.
    const segment = main.split(/[\\/]/).pop() ?? main
    const cut = segment.toLowerCase().lastIndexOf(FUNSCRIPT_EXTENSION)
    ver.name = cut > 0 ? segment.slice(0, cut) : segment
  }
}

/** Parses any sidecar version the app has ever written, as the current shape. */
export const AnyMediaMetaSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== 'object') return raw
  const record = raw as Record<string, unknown>
  // Applied in order, each one feeding the next, so a v1 file that has sat
  // untouched through two renames still arrives as the current shape.
  //
  // v1 sidecars are rewritten by upgradeV1 before the name fix-up runs too:
  // the literal "Default" version name predates schema v2, so a v1 file that
  // never gets rewritten since would otherwise keep showing it forever.
  let current = record.schemaVersion === 1 ? upgradeV1(record) : record
  if (current.schemaVersion === 2) current = upgradeV2(current)
  normalizeDefaultVersionNames(current)
  return current
}, MediaMetaSchema)

export type FileFingerprint = z.infer<typeof FileFingerprintSchema>
export type ScriptVersion = z.infer<typeof ScriptVersionSchema>
export type Subtitle = z.infer<typeof SubtitleSchema>
export type MediaInfo = z.infer<typeof MediaInfoSchema>
export type Wanted = z.infer<typeof WantedSchema>
export type MediaMeta = z.infer<typeof MediaMetaSchema>
