import { z } from 'zod'

/**
 * `<library root>/.fsmgr/state.json` — the library's non-derived state.
 *
 * Everything else about a library can be rebuilt by reading the disk: sidecars
 * are the truth and index.db is a cache of them. This file holds what cannot,
 * because it is a record of the user's intent rather than of the files: *don't
 * put this back*, and *keep the sidecars over there*.
 */

/**
 * Where a library writes its sidecars.
 *
 * - `beside`: next to each media file, `clip.mp4.meta.json` beside `clip.mp4`.
 * - `library`: in the library's own `.fsmgr/meta/`, folders mirroring the
 *   library's, so the media folders hold nothing but media and companions.
 * - `custom`: the same mirror in a folder the user picked, outside the library.
 *
 * The location lives in the library rather than in the app's settings so that
 * a library opened on another install is still read from where its sidecars
 * are. Looking in the wrong place would ingest every file as new.
 */
export const MetaLocationSchema = z.enum(['beside', 'library', 'custom'])
export type MetaLocation = z.infer<typeof MetaLocationSchema>

export const MetaStateSchema = z.object({
  location: MetaLocationSchema.default('beside'),
  /**
   * The mirror folder for `custom`, absolute, already including the library's
   * own subfolder. Empty for the other locations.
   */
  customDir: z.string().default(''),
  /**
   * Custom folders this library used before and has not finished moving out
   * of. They are read like any other location until they are empty, and a
   * scan does not run while one cannot be reached: an entry whose sidecar is
   * on an unplugged drive would otherwise be ingested again as new.
   */
  leftoverDirs: z.array(z.string()).default([])
})
export type MetaState = z.infer<typeof MetaStateSchema>

/** A library's sidecar location as the Libraries page shows it. */
export const MetaStatusSchema = MetaStateSchema.extend({
  /** Sidecars not yet in the chosen location, as of the last scan. */
  pending: z.number().int().nonnegative(),
  /** Folders holding sidecars that cannot be reached; the library is not scanned meanwhile. */
  unreachable: z.array(z.string())
})
export type MetaStatus = z.infer<typeof MetaStatusSchema>

/**
 * One entry the user removed from the library while keeping its files.
 *
 * Recognised by fingerprint first so a rename or a move does not undo the
 * removal, and by path when there is no fingerprint to go on — a placeholder
 * entry never had a media file, and a companion file is never hashed.
 */
export const IgnoredEntrySchema = z.object({
  /** The removed entry's id, so a re-add can be told from a coincidence. */
  id: z.uuid(),
  /** `<size>:<blake3Head>`; null for entries that never had a media file. */
  fingerprint: z.string().nullable().default(null),
  /** Library-relative media path at the time of removal. */
  path: z.string(),
  /** Shown in the list; the file name alone is often not enough to recognise it. */
  title: z.string().nullable().default(null),
  /**
   * Companion files removed along with the entry, library-relative. Without
   * these the scripts would be ownerless on the next scan and the library would
   * helpfully build a fresh placeholder entry out of them.
   */
  companions: z.array(z.string()).default([]),
  removedAt: z.iso.datetime()
})

export const LibraryStateSchema = z.object({
  schemaVersion: z.literal(1),
  ignored: z.array(IgnoredEntrySchema).default([]),
  /** Absent in files written before sidecars could live anywhere but beside the media. */
  metadata: MetaStateSchema.optional()
})

export type IgnoredEntry = z.infer<typeof IgnoredEntrySchema>
export type LibraryState = z.infer<typeof LibraryStateSchema>

export function emptyLibraryState(): LibraryState {
  return LibraryStateSchema.parse({ schemaVersion: 1 })
}

/** The key media files are matched on; `null` when the entry never had a file. */
export function fingerprintKey(size: number, blake3Head: string): string | null {
  return blake3Head ? `${size}:${blake3Head}` : null
}
