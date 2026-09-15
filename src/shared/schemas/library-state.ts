import { z } from 'zod'

/**
 * `<library root>/.fsmgr-library.json` — the library's non-derived state.
 *
 * Everything else about a library can be rebuilt by reading the disk: sidecars
 * are the truth and index.db is a cache of them. This file holds the one thing
 * that cannot, because it is a record of the user's intent rather than of the
 * files: *don't put this back*.
 */

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
  ignored: z.array(IgnoredEntrySchema).default([])
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
