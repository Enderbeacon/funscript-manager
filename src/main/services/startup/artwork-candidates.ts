import { extname, join } from 'node:path'
import Database from 'better-sqlite3'
import { INDEX_DB, LIBRARY_CACHE_DIR, VIDEO_EXTENSIONS } from '@shared/constants'
import type { RegisteredLibrary, Settings } from '@shared/schemas/app-config'
import type { FilterNode } from '@shared/schemas/taxonomy'
import { compileFilter } from '../db/filter-sql'

type Artwork = Settings['ui']['startupArtwork']

/** Read the existing index without initializing, migrating or rebuilding it. */
export function artworkCandidates(
  library: RegisteredLibrary,
  selection: Artwork,
  cachedNames: Set<string>
): string[] {
  if (cachedNames.size === 0) return []
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
    db = new Database(join(library.rootPath, LIBRARY_CACHE_DIR, INDEX_DB), {
      readonly: true, fileMustExist: true, timeout: 0
    })
    const rows = db.prepare(`
      SELECT m.id, m.file_path FROM media m
      WHERE m.missing = 0 AND m.wanted = 0 AND (${sql})
    `).iterate(params) as Iterable<{ id: string; file_path: string }>
    const candidates: string[] = []
    for (const row of rows) {
      const name = `${row.id}.jpg`
      if (!cachedNames.has(name)) continue
      if (!(VIDEO_EXTENSIONS as readonly string[]).includes(extname(row.file_path).toLowerCase())) continue
      candidates.push(join(library.rootPath, LIBRARY_CACHE_DIR, 'cache', 'thumbs', name))
    }
    return candidates
  } catch {
    // Offline, missing or incompatible indexes leave the bundled art visible.
    return []
  } finally {
    db?.close()
  }
}
