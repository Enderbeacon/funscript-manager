import { basename, extname, join } from 'node:path'
import Database from 'better-sqlite3'
import { INDEX_DB, LIBRARY_CACHE_DIR, VIDEO_EXTENSIONS } from '@shared/constants'
import type { RegisteredLibrary, Settings } from '@shared/schemas/app-config'
import type { FilterNode } from '@shared/schemas/taxonomy'
import { compileFilter } from '../db/filter-sql'

type Artwork = Settings['ui']['startupArtwork']

export interface ArtworkCandidate {
  libraryId: string
  mediaId: string
  mediaPath: string
  thumbnailPath: string
  highResPath: string
  /** What the startup card credits the frame to. */
  name: string
}

/** A video's title, or its file name without the extension when it has none. */
function displayName(title: string | null, filePath: string): string {
  return title?.trim() || basename(filePath, extname(filePath))
}

function openIndex(library: RegisteredLibrary): Database.Database {
  return new Database(join(library.rootPath, LIBRARY_CACHE_DIR, INDEX_DB), {
    readonly: true, fileMustExist: true, timeout: 0
  })
}

/**
 * Names for artwork already prepared, which is remembered by id alone. Missing
 * ids are left out; the card then shows the frame without a credit.
 */
export function artworkNames(library: RegisteredLibrary, mediaIds: string[]): Map<string, string> {
  const names = new Map<string, string>()
  if (mediaIds.length === 0) return names
  let db: Database.Database | undefined
  try {
    db = openIndex(library)
    const rows = db.prepare(`
      SELECT id, file_path, title FROM media WHERE id IN (${mediaIds.map(() => '?').join(', ')})
    `).all(...mediaIds) as { id: string; file_path: string; title: string | null }[]
    for (const row of rows) names.set(row.id, displayName(row.title, row.file_path))
  } catch {
    // Same as the candidates: an unreadable index only costs the credit.
  } finally {
    db?.close()
  }
  return names
}

/** Read the existing index without initializing, migrating or rebuilding it. */
export function artworkCandidates(
  library: RegisteredLibrary,
  selection: Artwork,
  cachedNames?: Set<string>
): ArtworkCandidate[] {
  if (cachedNames?.size === 0) return []
  const children: FilterNode[] = []
  for (const [field, values] of [
    ['tags', selection.tags], ['playlists', selection.playlists], ['folder', selection.folders]
  ] as const) {
    if (values.length) children.push({ kind: 'rule', field, op: 'includes', value: values })
  }
  // A selected library root supplies every video in that library, even if
  // tags or playlists are selected as additional sources.
  const filter: FilterNode | null = selection.folders.includes(`${library.id}/`)
    ? null : { kind: 'group', match: 'any', children }
  const { sql, params } = compileFilter(filter, library.id)
  let db: Database.Database | undefined
  try {
    db = openIndex(library)
    const rows = db.prepare(`
      SELECT m.id, m.file_path, m.title FROM media m
      WHERE m.missing = 0 AND m.wanted = 0 AND (${sql})
      ORDER BY m.file_path COLLATE NOCASE, m.id
    `).iterate(params) as Iterable<{ id: string; file_path: string; title: string | null }>
    const candidates: ArtworkCandidate[] = []
    for (const row of rows) {
      const name = `${row.id}.jpg`
      if (cachedNames && !cachedNames.has(name)) continue
      if (!(VIDEO_EXTENSIONS as readonly string[]).includes(extname(row.file_path).toLowerCase())) continue
      candidates.push({
        libraryId: library.id,
        mediaId: row.id,
        mediaPath: join(library.rootPath, row.file_path),
        thumbnailPath: join(library.rootPath, LIBRARY_CACHE_DIR, 'cache', 'thumbs', name),
        highResPath: join(library.rootPath, LIBRARY_CACHE_DIR, 'cache', 'startup-artwork', name),
        name: displayName(row.title, row.file_path)
      })
    }
    return candidates
  } catch {
    // Offline, missing or incompatible indexes leave the bundled art visible.
    return []
  } finally {
    db?.close()
  }
}
