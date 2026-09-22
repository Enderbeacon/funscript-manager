import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import Database from 'better-sqlite3'
import { INDEX_DB, LIBRARY_CACHE_DIR } from '@shared/constants'
import type { MediaListItem, MediaListPage } from '@shared/schemas/media-index'
import type { MediaMeta, NameField } from '@shared/schemas/media-meta'
import type { FilterNode } from '@shared/schemas/taxonomy'
import { VrFormatSchema, type VrFormat } from '@shared/schemas/vr-video'
import { FLAT_VR_FORMAT } from '@shared/vr-video'
import { isMultiAxis } from '../library/companion-grouping'
import { compileFilter } from './filter-sql'

/**
 * Per-library SQLite index. Strictly a derived cache: every row is
 * rebuildable from sidecars + library.json. If the file is missing or fails
 * to open/migrate, it is deleted and recreated empty — the scanner's diff
 * sync against an empty index is exactly the full-rebuild path.
 *
 * media_fts is a standalone FTS5 table
 * (media_id UNINDEXED) instead of external-content over `media`, because
 * FTS5 external content requires an integer rowid and media.id is a UUID.
 */

const SCHEMA_VERSION = 7

/** GROUP_CONCAT separator (SQL `char(31)`, the ASCII unit separator). */
const SEP = String.fromCharCode(31)

/** How a row is marked, from the `vr` column; `flat` when unmarked. */
function rowVrFormat(vr: string | null): VrFormat {
  if (!vr) return FLAT_VR_FORMAT
  try {
    const parsed = VrFormatSchema.safeParse(JSON.parse(vr))
    return parsed.success ? parsed.data : FLAT_VR_FORMAT
  } catch {
    return FLAT_VR_FORMAT
  }
}

/** Sidecar name list → the table that indexes it. Order is the write order. */
const NAME_TABLES = new Map<NameField, string>([
  ['tags', 'media_tag'],
  ['videoAuthors', 'media_video_author'],
  ['scriptAuthors', 'media_script_author'],
  ['studios', 'media_studio'],
  ['playlists', 'media_playlist']
])

const SCHEMA = `
CREATE TABLE media (
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL UNIQUE,
  file_size INTEGER,
  fingerprint TEXT,
  title TEXT,
  duration_ms INTEGER,
  resolution TEXT,
  codec TEXT,
  -- How the user marked the file, as the sidecar's vr field in JSON. NULL
  -- when unmarked, which plays as flat.
  vr TEXT,
  missing INTEGER NOT NULL DEFAULT 0,
  -- 1 = the file has never arrived (bought elsewhere, still to be supplied);
  -- distinct from "missing", which also covers a file that went away.
  wanted INTEGER NOT NULL DEFAULT 0,
  -- Denormalised from userMeta so filtering and sorting need no join.
  rating INTEGER,
  favorite INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  updated_at TEXT,
  -- What the filesystem says about the entry's own files, in epoch ms: when
  -- they arrived here, and when one of them last changed. The two "recent"
  -- sorts read these rather than created_at/updated_at, which are the
  -- sidecar's and say only when this app first wrote one — on a first import,
  -- the same minute for the whole library.
  file_added_at INTEGER,
  file_modified_at INTEGER,
  sidecar_mtime INTEGER
);
CREATE INDEX idx_media_path ON media(file_path);
CREATE INDEX idx_media_file_added ON media(file_added_at);
CREATE INDEX idx_media_file_modified ON media(file_modified_at);
CREATE INDEX idx_media_fingerprint ON media(fingerprint);

-- One table per kind of name a media carries. Same shape throughout, so the
-- filter compiler treats them identically and adding a kind is one more table
-- rather than one more special case.
CREATE TABLE media_tag (
  media_id TEXT,
  name TEXT,
  PRIMARY KEY (media_id, name)
);
CREATE INDEX idx_media_tag_name ON media_tag(name);

CREATE TABLE media_video_author (
  media_id TEXT,
  name TEXT,
  PRIMARY KEY (media_id, name)
);
CREATE INDEX idx_media_video_author_name ON media_video_author(name);

CREATE TABLE media_script_author (
  media_id TEXT,
  name TEXT,
  PRIMARY KEY (media_id, name)
);
CREATE INDEX idx_media_script_author_name ON media_script_author(name);

CREATE TABLE media_studio (
  media_id TEXT,
  name TEXT,
  PRIMARY KEY (media_id, name)
);
CREATE INDEX idx_media_studio_name ON media_studio(name);

CREATE TABLE media_playlist (
  media_id TEXT,
  name TEXT,
  -- Position within this playlist; NULL for a playlist never put in an order
  -- (every migrated collection starts that way). Sorts as plain text, which is
  -- what the key encoding is designed for — see shared/rank.ts.
  rank TEXT,
  PRIMARY KEY (media_id, name)
);
CREATE INDEX idx_media_playlist_name ON media_playlist(name);
CREATE INDEX idx_media_playlist_order ON media_playlist(name, rank);

CREATE TABLE media_source (
  media_id TEXT,
  source_type TEXT,
  source_url TEXT,
  fetched_at TEXT
);

CREATE TABLE media_subtitle (
  media_id TEXT,
  language TEXT,
  path TEXT
);

-- Every companion file a sidecar points at, as a library-relative path.
-- Sidecars store paths relative to their own media, which answers "where is
-- this version's roll axis" but cannot answer "who else uses this file" —
-- and three separate features have to ask exactly that: deleting files,
-- renaming a media without its companions, and reclaiming placeholders.
-- Ownership by filename pattern was the old answer and it was wrong: a script
-- belongs to whoever's sidecar names it, whatever it happens to be called.
CREATE TABLE media_file_ref (
  media_id TEXT,
  kind TEXT,           -- 'script' | 'subtitle'
  path TEXT,           -- library-relative, forward slashes, original case
  path_key TEXT        -- same path lowercased; Windows paths are case-insensitive
);
CREATE INDEX idx_media_file_ref_key ON media_file_ref(path_key);
CREATE INDEX idx_media_file_ref_media ON media_file_ref(media_id);

CREATE TABLE script_version (
  id TEXT PRIMARY KEY,
  media_id TEXT,
  name TEXT,
  author TEXT,
  is_multi_axis INTEGER,
  is_default INTEGER
);
CREATE INDEX idx_script_version_media ON script_version(media_id);

CREATE VIRTUAL TABLE media_fts USING fts5(media_id UNINDEXED, title, tags, notes);
`

// Download jobs deliberately do NOT live here: this file is deleted and
// rebuilt whenever it fails to open or its schema version moves, and a queue
// is not rebuildable from anything. They are in <userData>/downloads.db
// instead (see services/downloaders/store.ts).

/**
 * A companion path as the sidecar stores it (relative to its own media file),
 * resolved against the library root so two sidecars in different folders can
 * be compared. `../scripts/a.funscript` next to `sub/dir/v.mp4` becomes
 * `sub/scripts/a.funscript`.
 */
function toLibraryRelative(mediaRelPath: string, companionRelPath: string): string {
  const dir = posix.dirname(mediaRelPath.split('\\').join('/'))
  const joined = posix.join(dir === '.' ? '' : dir, companionRelPath.split('\\').join('/'))
  return posix.normalize(joined)
}

/** Every companion file a sidecar names, as library-relative paths. */
export function companionRefs(
  meta: MediaMeta,
  mediaRelPath: string
): { kind: 'script' | 'subtitle'; path: string }[] {
  const out: { kind: 'script' | 'subtitle'; path: string }[] = []
  const seen = new Set<string>()
  const push = (kind: 'script' | 'subtitle', rel: string): void => {
    const path = toLibraryRelative(mediaRelPath, rel)
    const key = `${kind}:${path.toLowerCase()}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ kind, path })
  }
  for (const version of meta.scriptVersions) {
    for (const file of Object.values(version.files)) if (file) push('script', file)
  }
  for (const sub of meta.subtitles) push('subtitle', sub.path)
  return out
}

/**
 * What the filesystem says about one entry's files, epoch ms.
 *
 * `addedAt` is the media file's creation time — when this copy of it came to
 * be here, which is what "recently added" means to someone looking at a
 * library they have been filling for years. An entry with no media file yet
 * falls back to the earliest of its scripts.
 *
 * `modifiedAt` is the newest change across everything the entry owns — video,
 * scripts, subtitles — and the entry's own last edit, so that giving something
 * a rating or attaching a new script both count as changing it.
 */
export interface EntryFileTimes {
  addedAt: number | null
  modifiedAt: number | null
}

/** One media that also points at a file some other operation is about to touch. */
export interface FileUser {
  mediaId: string
  /** The file in question, library-relative. */
  path: string
  /** Where that media itself lives, library-relative. */
  mediaPath: string
  title: string | null
  wanted: boolean
}

export interface IndexedMediaRow {
  id: string
  filePath: string
  fileSize: number | null
  fingerprint: string | null
  sidecarMtime: number | null
  missing: boolean
}

/**
 * The errors that mean the file itself is damaged, rather than the statement
 * being wrong. Nothing but a rebuild gets past these.
 */
export function isIndexCorruption(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code
  return code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB'
}

export class LibraryIndexDb {
  private constructor(
    private db: Database.Database,
    private readonly dbPath: string
  ) {}

  /** Open (or recreate, if absent/corrupt/outdated) `<root>/.fsmgr-cache/index.db`. */
  static open(libraryRoot: string): LibraryIndexDb {
    const dbPath = join(libraryRoot, LIBRARY_CACHE_DIR, INDEX_DB)
    mkdirSync(dirname(dbPath), { recursive: true })
    try {
      return new LibraryIndexDb(LibraryIndexDb.openAt(dbPath), dbPath)
    } catch (e) {
      // Disposable cache: nuke and start empty; the next scan rebuilds it from sidecars.
      // openAt closed its handle before re-throwing, so the files are free to
      // unlink; log the original error too — a silent catch would otherwise
      // surface only the rmSync EPERM and hide the real reason we are here.
      console.error(`[index] reopening ${dbPath}:`, e)
      return new LibraryIndexDb(LibraryIndexDb.recreate(dbPath), dbPath)
    }
  }

  /**
   * Throw a damaged index away and open a fresh empty one, keeping this object
   * (and every reference to it) alive. The caller has to follow with a sync:
   * the new file has no rows, and only the scanner can put them back.
   */
  rebuild(): void {
    try {
      this.db.close()
    } catch {
      // Already unusable; the files are what matter.
    }
    this.db = LibraryIndexDb.recreate(this.dbPath)
  }

  /** Delete the index files and open a fresh, empty database in their place. */
  private static recreate(dbPath: string): Database.Database {
    rmSync(dbPath, { force: true })
    rmSync(`${dbPath}-wal`, { force: true })
    rmSync(`${dbPath}-shm`, { force: true })
    return LibraryIndexDb.openAt(dbPath)
  }

  /**
   * The current schema has this column and no earlier one did. Checking the
   * shape, not only the stamp, is deliberate: deleting the file to rebuild it
   * left a database stamped with the new version and still carrying the old
   * tables, because a leftover `-wal` replayed the old pages back into the
   * fresh file. A stamp is a claim; a column is the fact.
   */
  private static hasCurrentShape(db: Database.Database): boolean {
    try {
      const columns = db.pragma('table_info(media)') as { name: string }[]
      if (!columns.some((c) => c.name === 'file_added_at')) return false
      const refs = db.pragma('table_info(media_file_ref)') as { name: string }[]
      return refs.length > 0
    } catch {
      return false
    }
  }

  /**
   * Rebuild inside the open database rather than replacing the file. Windows
   * will not always let a just-closed database be unlinked, and the index is
   * derived data — dropping every object and re-running the schema reaches the
   * same place without depending on the filesystem letting go.
   */
  private static resetSchema(db: Database.Database): void {
    const objects = db
      .prepare("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
      .all() as { name: string; type: string }[]
    const tx = db.transaction(() => {
      // FTS shadow tables go with their virtual table, so those are skipped.
      for (const { name, type } of objects) {
        if (type === 'index' || name.startsWith('media_fts_')) continue
        db.exec(`DROP ${type === 'view' ? 'VIEW' : 'TABLE'} IF EXISTS "${name}"`)
      }
      db.exec(SCHEMA)
    })
    tx()
    db.pragma(`user_version = ${SCHEMA_VERSION}`)
  }

  private static openAt(dbPath: string): Database.Database {
    const db = new Database(dbPath)
    try {
      db.pragma('journal_mode = WAL')
      const version = db.pragma('user_version', { simple: true }) as number
      if (version === 0 && !LibraryIndexDb.hasCurrentShape(db)) {
        db.exec(SCHEMA)
        db.pragma(`user_version = ${SCHEMA_VERSION}`)
      } else if (version !== SCHEMA_VERSION || !LibraryIndexDb.hasCurrentShape(db)) {
        console.log(`[index] rebuilding: version ${version}, expected ${SCHEMA_VERSION}`)
        LibraryIndexDb.resetSchema(db)
      }
      // Read every page, not just one row of one table. A count over `media`
      // was the old probe, and it waved through a file whose damage lay in
      // another tree — the library opened fine and then threw SQLITE_CORRUPT
      // on the first listing, every run, with nothing ever repairing it.
      const check = db.pragma('quick_check', { simple: true }) as string
      if (check !== 'ok') throw new Error(`quick_check: ${check.split('\n')[0]}`)
      return db
    } catch (e) {
      // Drop the handle before re-throwing: better-sqlite3 keeps the file
      // locked until close, so a leaked handle would make the very rmSync that
      // recovers the index fail with EPERM (mirrors downloads store.ts).
      db.close()
      throw e
    }
  }

  /** All indexed media rows (for the scanner's diff pass). */
  listIndexed(): IndexedMediaRow[] {
    const rows = this.db
      .prepare('SELECT id, file_path, file_size, fingerprint, sidecar_mtime, missing FROM media')
      .all() as {
      id: string
      file_path: string
      file_size: number | null
      fingerprint: string | null
      sidecar_mtime: number | null
      missing: number
    }[]
    return rows.map((r) => ({
      id: r.id,
      filePath: r.file_path,
      fileSize: r.file_size,
      fingerprint: r.fingerprint,
      sidecarMtime: r.sidecar_mtime,
      missing: r.missing !== 0
    }))
  }

  /**
   * Upsert one media entry and all derived relations from its sidecar.
   *
   * `times` comes from the scanner, which is the only caller that has just
   * looked at the files; leaving it out keeps the times already stored.
   */
  upsertFromSidecar(
    meta: MediaMeta,
    relPath: string,
    sidecarMtime: number,
    times?: EntryFileTimes
  ): void {
    const tx = this.db.transaction(() => {
      // A moved file can collide on the UNIQUE path with a stale row; the
      // stale row loses (its sidecar no longer exists at that path).
      this.db
        .prepare('DELETE FROM media WHERE file_path = ? AND id <> ?')
        .run(relPath, meta.id)
      this.db
        .prepare(
          `INSERT INTO media (id, file_path, file_size, fingerprint, title, duration_ms, resolution, codec, vr, missing, wanted, rating, favorite, created_at, updated_at, file_added_at, file_modified_at, sidecar_mtime)
           VALUES (@id, @filePath, @fileSize, @fingerprint, @title, @durationMs, @resolution, @codec, @vr, @wanted, @wanted, @rating, @favorite, @createdAt, @updatedAt, @fileAddedAt, @fileModifiedAt, @sidecarMtime)
           ON CONFLICT(id) DO UPDATE SET
             file_path = @filePath, file_size = @fileSize, fingerprint = @fingerprint,
             title = @title, duration_ms = @durationMs, resolution = @resolution, codec = @codec,
             vr = @vr,
             missing = @wanted, wanted = @wanted,
             rating = @rating, favorite = @favorite,
             created_at = @createdAt, updated_at = @updatedAt,
             -- Only the scanner has been to the filesystem; an edit coming
             -- through here keeps whatever it last found.
             file_added_at = COALESCE(@fileAddedAt, file_added_at),
             file_modified_at = COALESCE(@fileModifiedAt, file_modified_at),
             sidecar_mtime = @sidecarMtime`
        )
        .run({
          id: meta.id,
          filePath: relPath,
          fileSize: meta.fileFingerprint.size,
          fingerprint: meta.fileFingerprint.blake3Head,
          title: meta.title ?? null,
          durationMs: meta.mediaInfo?.durationMs ?? null,
          resolution:
            meta.mediaInfo?.width && meta.mediaInfo?.height
              ? `${meta.mediaInfo.width}x${meta.mediaInfo.height}`
              : null,
          codec: meta.mediaInfo?.videoCodec ?? meta.mediaInfo?.audioCodec ?? null,
          vr: meta.vr ? JSON.stringify(meta.vr) : null,
          // A placeholder is missing by definition: there is no file yet.
          wanted: meta.wanted ? 1 : 0,
          rating: meta.userMeta.rating ?? null,
          favorite: meta.userMeta.favorite ? 1 : 0,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          fileAddedAt: times?.addedAt ?? null,
          fileModifiedAt: times?.modifiedAt ?? null,
          sidecarMtime
        })

      for (const table of [
        ...NAME_TABLES.values(),
        'media_source',
        'media_subtitle',
        'media_file_ref',
        'script_version'
      ]) {
        this.db.prepare(`DELETE FROM ${table} WHERE media_id = ?`).run(meta.id)
      }
      this.db.prepare('DELETE FROM media_fts WHERE media_id = ?').run(meta.id)

      for (const [field, table] of NAME_TABLES) {
        const insert = this.db.prepare(`INSERT OR IGNORE INTO ${table} (media_id, name) VALUES (?, ?)`)
        for (const name of meta[field]) insert.run(meta.id, name)
      }
      // Ranks ride along with playlist membership. Written separately so the
      // loop above stays the one that handles every name list the same way;
      // a name with no rank keeps NULL and sorts as "never ordered".
      const insRank = this.db.prepare('UPDATE media_playlist SET rank = ? WHERE media_id = ? AND name = ?')
      for (const [name, rank] of Object.entries(meta.playlistRanks)) {
        insRank.run(rank, meta.id, name)
      }

      const insSource = this.db.prepare(
        'INSERT INTO media_source (media_id, source_type, source_url, fetched_at) VALUES (?, ?, ?, ?)'
      )
      for (const s of meta.sources) insSource.run(meta.id, s.type, s.url, s.fetchedAt ?? null)

      const insSub = this.db.prepare(
        'INSERT INTO media_subtitle (media_id, language, path) VALUES (?, ?, ?)'
      )
      for (const sub of meta.subtitles) insSub.run(meta.id, sub.language ?? null, sub.path)

      const insVersion = this.db.prepare(
        `INSERT OR REPLACE INTO script_version (id, media_id, name, author, is_multi_axis, is_default)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      for (const v of meta.scriptVersions) {
        insVersion.run(v.id, meta.id, v.name, v.author ?? null, isMultiAxis(v) ? 1 : 0, v.isDefault ? 1 : 0)
      }

      const insRef = this.db.prepare(
        'INSERT INTO media_file_ref (media_id, kind, path, path_key) VALUES (?, ?, ?, ?)'
      )
      for (const ref of companionRefs(meta, relPath)) {
        insRef.run(meta.id, ref.kind, ref.path, ref.path.toLowerCase())
      }

      this.db
        .prepare('INSERT INTO media_fts (media_id, title, tags, notes) VALUES (?, ?, ?, ?)')
        .run(meta.id, meta.title ?? '', meta.tags.join(' '), meta.userMeta.notes ?? '')
    })
    tx()
  }

  updatePath(id: string, relPath: string): void {
    this.db.prepare('UPDATE media SET file_path = ?, missing = 0 WHERE id = ?').run(relPath, id)
  }

  setMissing(id: string, missing: boolean): void {
    this.db.prepare('UPDATE media SET missing = ? WHERE id = ?').run(missing ? 1 : 0, id)
  }

  remove(id: string): void {
    const tx = this.db.transaction(() => {
      for (const table of [
        ...NAME_TABLES.values(),
        'media_source',
        'media_subtitle',
        'media_file_ref',
        'script_version'
      ]) {
        this.db.prepare(`DELETE FROM ${table} WHERE media_id = ?`).run(id)
      }
      this.db.prepare('DELETE FROM media_fts WHERE media_id = ?').run(id)
      this.db.prepare('DELETE FROM media WHERE id = ?').run(id)
    })
    tx()
  }

  findByFingerprint(blake3Head: string, size: number): IndexedMediaRow | null {
    const r = this.db
      .prepare(
        'SELECT id, file_path, file_size, fingerprint, sidecar_mtime, missing FROM media WHERE fingerprint = ? AND file_size = ?'
      )
      .get(blake3Head, size) as
      | {
          id: string
          file_path: string
          file_size: number | null
          fingerprint: string | null
          sidecar_mtime: number | null
          missing: number
        }
      | undefined
    if (!r) return null
    return {
      id: r.id,
      filePath: r.file_path,
      fileSize: r.file_size,
      fingerprint: r.fingerprint,
      sidecarMtime: r.sidecar_mtime,
      missing: r.missing !== 0
    }
  }

  /** Media id at a library-relative path (null when not indexed yet). */
  findIdByRelPath(relPath: string): string | null {
    const r = this.db.prepare('SELECT id FROM media WHERE file_path = ?').get(relPath) as
      | { id: string }
      | undefined
    return r?.id ?? null
  }

  /**
   * The same lookup, ignoring case.
   *
   * For following a player rather than driving it: a path typed into mpv or
   * picked in another program comes back in whatever case that program used,
   * and on Windows `E:\Clips\a.mp4` and `e:\clips\a.mp4` are one file.
   */
  findIdByRelPathInsensitive(relPath: string): string | null {
    const r = this.db
      .prepare('SELECT id FROM media WHERE file_path = ? COLLATE NOCASE')
      .get(relPath) as { id: string } | undefined
    return r?.id ?? null
  }

  /**
   * Media already carrying this source URL — "did I download this post
   * before?", asked before a post's video is queued again. media_source is written from the
   * sidecar, so this is as authoritative as the sidecars are.
   */
  findIdBySourceUrl(url: string): string | null {
    const r = this.db
      .prepare('SELECT media_id FROM media_source WHERE source_url = ? LIMIT 1')
      .get(url) as { media_id: string } | undefined
    return r?.media_id ?? null
  }

  /**
   * Any entry already pointing at this forum topic, whatever shape the stored
   * URL has. The same topic gets written as `/t/slug/123`, `/t/123` and
   * `/t/slug/123/45` depending on where the link was copied from, so matching
   * the string exactly would report "not linked yet" for posts that are.
   */
  findIdByTopicId(topicId: number): string | null {
    const r = this.db
      .prepare(
        `SELECT media_id FROM media_source
          WHERE source_url LIKE '%/t/' || ? OR source_url LIKE '%/t/' || ? || '/%'
             OR source_url LIKE '%/t/%/' || ? OR source_url LIKE '%/t/%/' || ? || '/%'
          LIMIT 1`
      )
      .get(topicId, topicId, topicId, topicId) as { media_id: string } | undefined
    return r?.media_id ?? null
  }

  /** Another media with the same content, ignoring the one just added. */
  /**
   * Real media (not placeholders) whose file name, extension aside, is one of
   * `bases`. Used to spot the video a user dropped in by hand for an entry that
   * is still waiting for one — a scene bought elsewhere almost always arrives
   * named after the script that came with the post.
   */
  /**
   * Entries with no forum post recorded — the worklist for a matching run.
   *
   * Placeholders are left out: an entry whose file never arrived already knows
   * which post it is waiting for, that being where it came from.
   */
  idsWithoutPostSource(): { id: string; filePath: string }[] {
    return this.db
      .prepare(
        `SELECT id, file_path AS filePath FROM media
          WHERE wanted = 0
            AND NOT EXISTS (
              SELECT 1 FROM media_source s
               WHERE s.media_id = media.id AND s.source_type = 'eroscripts'
            )
          ORDER BY file_path`
      )
      .all() as { id: string; filePath: string }[]
  }

  findByBaseNames(bases: string[], excludeId: string): { id: string; filePath: string }[] {
    if (bases.length === 0) return []
    const wanted = new Set(bases.map((b) => b.toLowerCase()))
    const rows = this.db
      .prepare('SELECT id, file_path FROM media WHERE wanted = 0 AND id <> ?')
      .all(excludeId) as { id: string; file_path: string }[]
    return rows
      .filter((r) => {
        const name = r.file_path.split('/').pop() ?? r.file_path
        const dot = name.lastIndexOf('.')
        return wanted.has((dot === -1 ? name : name.slice(0, dot)).toLowerCase())
      })
      .map((r) => ({ id: r.id, filePath: r.file_path }))
  }

  findFingerprintTwin(blake3Head: string, size: number, excludeId: string): IndexedMediaRow | null {
    const r = this.db
      .prepare(
        `SELECT id, file_path, file_size, fingerprint, sidecar_mtime, missing FROM media
          WHERE fingerprint = ? AND file_size = ? AND id <> ? LIMIT 1`
      )
      .get(blake3Head, size, excludeId) as
      | {
          id: string
          file_path: string
          file_size: number | null
          fingerprint: string | null
          sidecar_mtime: number | null
          missing: number
        }
      | undefined
    if (!r) return null
    return {
      id: r.id,
      filePath: r.file_path,
      fileSize: r.file_size,
      fingerprint: r.fingerprint,
      sidecarMtime: r.sidecar_mtime,
      missing: r.missing !== 0
    }
  }

  /** Companion files one media names, library-relative. */
  filesOf(mediaId: string): { kind: 'script' | 'subtitle'; path: string }[] {
    return this.db
      .prepare('SELECT kind, path FROM media_file_ref WHERE media_id = ?')
      .all(mediaId) as { kind: 'script' | 'subtitle'; path: string }[]
  }

  /**
   * Who else points at these files. This is what stands between "delete this
   * entry's files" and quietly breaking another entry that shares a script —
   * which happens whenever a version was added by reference rather than copied.
   */
  othersUsing(paths: string[], excludeIds: string[]): FileUser[] {
    if (paths.length === 0) return []
    const keys = paths.map((p) => p.toLowerCase())
    const keyPlaceholders = keys.map(() => '?').join(',')
    const excludePlaceholders = excludeIds.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT r.media_id, r.path, m.file_path, m.title, m.wanted
           FROM media_file_ref r JOIN media m ON m.id = r.media_id
          WHERE r.path_key IN (${keyPlaceholders})
            ${excludeIds.length > 0 ? `AND r.media_id NOT IN (${excludePlaceholders})` : ''}`
      )
      .all(...keys, ...excludeIds) as {
      media_id: string
      path: string
      file_path: string
      title: string | null
      wanted: number
    }[]
    return rows.map((r) => ({
      mediaId: r.media_id,
      path: r.path,
      mediaPath: r.file_path,
      title: r.title,
      wanted: r.wanted !== 0
    }))
  }

  /** Every companion path the library accounts for, lowercased — scan-time ownership. */
  referencedPathKeys(): Set<string> {
    const rows = this.db.prepare('SELECT DISTINCT path_key FROM media_file_ref').all() as {
      path_key: string
    }[]
    return new Set(rows.map((r) => r.path_key))
  }

  /**
   * Placeholders whose every script has since been claimed by a media that
   * actually has a file — the entry has nothing left to hold. Partial claims do
   * not count: those may well be a split the user meant.
   */
  reclaimablePlaceholderIds(): string[] {
    const rows = this.db
      .prepare(
        `SELECT p.id FROM media p
          WHERE p.wanted = 1
            AND EXISTS (SELECT 1 FROM media_file_ref r
                         WHERE r.media_id = p.id AND r.kind = 'script')
            AND NOT EXISTS (
              SELECT 1 FROM media_file_ref r
               WHERE r.media_id = p.id AND r.kind = 'script'
                 AND NOT EXISTS (
                   SELECT 1 FROM media_file_ref r2 JOIN media m2 ON m2.id = r2.media_id
                    WHERE r2.path_key = r.path_key
                      AND m2.id <> p.id AND m2.wanted = 0 AND m2.missing = 0
                 )
            )`
      )
      .all() as { id: string }[]
    return rows.map((r) => r.id)
  }

  /** Library-relative path of one media row (null if unknown id). */
  /** When this entry's file arrived, as the detail page shows it (epoch ms). */
  fileAddedAt(id: string): number | null {
    const r = this.db
      .prepare(
        'SELECT COALESCE(file_added_at, unixepoch(created_at) * 1000) AS t FROM media WHERE id = ?'
      )
      .get(id) as { t: number | null } | undefined
    return r?.t ?? null
  }

  /**
   * How a media's picture is stored, for the parts of the app that hold only
   * its id — the thumbnail, which has to cut one eye out before it can show
   * a representative frame.
   */
  vrFormat(id: string): VrFormat {
    const r = this.db.prepare('SELECT vr FROM media WHERE id = ?').get(id) as
      | { vr: string | null }
      | undefined
    return rowVrFormat(r?.vr ?? null)
  }

  getMediaRelPath(id: string): string | null {
    const r = this.db.prepare('SELECT file_path FROM media WHERE id = ?').get(id) as
      | { file_path: string }
      | undefined
    return r?.file_path ?? null
  }

  /**
   * Paged media list. The search box and the filter tree are separate inputs
   * because they come from separate controls; both narrow, neither replaces
   * the other.
   */
  listMedia(
    libraryId: string,
    opts: {
      offset: number
      limit: number
      search?: string
      filter?: FilterNode | null
      sort?: MediaSort
      /** Which playlist `sort: 'playlist'` means. */
      playlistOrder?: string
      /**
       * Only these rows. For the queue, which is a list of ids and needs the
       * titles behind them — one query rather than one round trip per item.
       */
      ids?: string[]
    }
  ): MediaListPage {
    if (opts.ids?.length === 0) return { items: [], total: 0 }
    const compiled = compileFilter(opts.filter, libraryId)
    const clauses = [compiled.sql]
    if (opts.search) clauses.push('(m.file_path LIKE @q OR m.title LIKE @q)')
    if (opts.ids) clauses.push(`m.id IN (${opts.ids.map((_, i) => `@mid${i}`).join(',')})`)
    const where = `WHERE ${clauses.filter((c) => c !== '1').join(' AND ') || '1'}`

    const params: Record<string, unknown> = {
      ...compiled.params,
      offset: opts.offset,
      limit: opts.limit,
      ...(opts.search ? { q: `%${opts.search}%` } : {}),
      ...(opts.sort === 'playlist' && opts.playlistOrder ? { plOrder: opts.playlistOrder } : {}),
      ...Object.fromEntries((opts.ids ?? []).map((id, i) => [`mid${i}`, id]))
    }

    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM media m ${where}`).get(params) as { n: number }
    ).n

    const rows = this.db
      .prepare(
        `SELECT m.id, m.file_path, m.file_size, m.title, m.missing, m.wanted,
           COALESCE(m.file_added_at, unixepoch(m.created_at) * 1000) AS added_at,
           COALESCE(m.file_modified_at, unixepoch(m.updated_at) * 1000) AS modified_at,
           m.rating, m.favorite, m.duration_ms, m.vr,
           (SELECT COUNT(*) FROM script_version sv WHERE sv.media_id = m.id) AS script_count,
           (SELECT MAX(sv.is_multi_axis) FROM script_version sv WHERE sv.media_id = m.id) AS multi_axis,
           (SELECT GROUP_CONCAT(t.name, char(31)) FROM media_tag t WHERE t.media_id = m.id) AS tags,
           (SELECT GROUP_CONCAT(COALESCE(s.language, ''), char(31)) FROM media_subtitle s WHERE s.media_id = m.id) AS sub_langs,
           ${
             opts.sort === 'playlist' && opts.playlistOrder
               ? '(SELECT p.rank FROM media_playlist p WHERE p.media_id = m.id AND p.name = @plOrder COLLATE NOCASE)'
               : 'NULL'
           } AS playlist_rank
         FROM media m ${where}
         ORDER BY ${orderBy(opts.sort, opts.playlistOrder)}
         LIMIT @limit OFFSET @offset`
      )
      .all(params) as {
      id: string
      file_path: string
      file_size: number | null
      title: string | null
      missing: number
      wanted: number
      added_at: number | null
      modified_at: number | null
      rating: number | null
      favorite: number
      duration_ms: number | null
      vr: string | null
      script_count: number
      multi_axis: number | null
      tags: string | null
      sub_langs: string | null
      playlist_rank: string | null
    }[]

    const items: MediaListItem[] = rows.map((r) => {
      const tags = r.tags ? r.tags.split(SEP) : []
      return {
        id: r.id,
        libraryId,
        filePath: r.file_path,
        fileName: r.file_path.split('/').pop() ?? r.file_path,
        title: r.title,
        fileSize: r.file_size,
        missing: r.missing !== 0,
        wanted: r.wanted !== 0,
        tags,
        rating: r.rating,
        favorite: r.favorite !== 0,
        durationMs: r.duration_ms,
        vr: rowVrFormat(r.vr),
        scriptVersionCount: r.script_count,
        hasMultiAxis: (r.multi_axis ?? 0) !== 0,
        subtitleLanguages: r.sub_langs ? r.sub_langs.split(SEP).filter((l) => l !== '') : [],
        addedAt: r.added_at,
        modifiedAt: r.modified_at,
        playlistRank: r.playlist_rank
      }
    })

    return { items, total }
  }

  /**
   * How many media carry each name, for the counts beside every row of the
   * filter sidebar. Counted over the whole library, not the current result:
   * a count that changes as you tick things gives no sense of what is there.
   */
  nameCounts(): Record<NameField, Record<string, number>> {
    const out = {} as Record<NameField, Record<string, number>>
    for (const [field, table] of NAME_TABLES) {
      const rows = this.db
        .prepare(`SELECT name, COUNT(*) AS n FROM ${table} GROUP BY name`)
        .all() as { name: string; n: number }[]
      out[field] = Object.fromEntries(rows.map((r) => [r.name, r.n]))
    }
    return out
  }

  /**
   * One playlist's members in their order, with the rank each carries.
   *
   * Ranked rows first, then the ones never given a place, each group by path —
   * the same order `listMedia` produces, because the two have to agree about
   * what "the list" looks like before a drop between two rows can be worked out.
   */
  playlistMembers(name: string): { mediaId: string; rank: string | null; filePath: string }[] {
    return this.db
      .prepare(
        `SELECT p.media_id AS mediaId, p.rank AS rank, m.file_path AS filePath
           FROM media_playlist p JOIN media m ON m.id = p.media_id
          WHERE p.name = ? COLLATE NOCASE
          ORDER BY p.rank NULLS LAST, m.file_path`
      )
      .all(name) as { mediaId: string; rank: string | null; filePath: string }[]
  }

  /** Media carrying one name, for rename / merge / delete to rewrite. */
  idsWithName(field: NameField, name: string): string[] {
    const table = NAME_TABLES.get(field)
    if (!table) return []
    const rows = this.db
      .prepare(`SELECT media_id FROM ${table} WHERE name = ? COLLATE NOCASE`)
      .all(name) as { media_id: string }[]
    return rows.map((r) => r.media_id)
  }

  /** Ids matching a filter, for "select all" over a result larger than a page. */
  matchingIds(libraryId: string, opts: { search?: string; filter?: FilterNode | null }): string[] {
    const compiled = compileFilter(opts.filter, libraryId)
    const clauses = [compiled.sql]
    if (opts.search) clauses.push('(m.file_path LIKE @q OR m.title LIKE @q)')
    const where = `WHERE ${clauses.filter((c) => c !== '1').join(' AND ') || '1'}`
    const rows = this.db
      .prepare(`SELECT m.id FROM media m ${where}`)
      .all({ ...compiled.params, ...(opts.search ? { q: `%${opts.search}%` } : {}) }) as {
      id: string
    }[]
    return rows.map((r) => r.id)
  }

  close(): void {
    this.db.close()
  }
}

/**
 * Sort orders the grid offers. File path is always the tiebreak so paging is
 * stable — two media with the same rating must not swap places between pages.
 */
export type MediaSort =
  | 'path'
  | 'title'
  | 'addedAt'
  | 'updatedAt'
  | 'size'
  | 'rating'
  | 'scriptCount'
  /** The order the user dragged a playlist into; needs `playlistOrder`. */
  | 'playlist'

function orderBy(sort: MediaSort | undefined, playlistOrder?: string): string {
  // A playlist that has never been dragged has no ranks at all, and one being
  // reordered for the first time has them only on the rows already moved. Both
  // read as "the rest, in path order, after the ones that have a place".
  if (sort === 'playlist' && playlistOrder) {
    return `(SELECT p.rank FROM media_playlist p WHERE p.media_id = m.id AND p.name = @plOrder COLLATE NOCASE)
            NULLS LAST, m.file_path`
  }
  switch (sort) {
    case 'title':
      return 'COALESCE(NULLIF(m.title, \'\'), m.file_path) COLLATE NOCASE, m.file_path'
    // Both fall back to the sidecar's own stamps for a row the scanner has not
    // reached yet, so a fresh index still sorts in a sensible order.
    case 'addedAt':
      return 'COALESCE(m.file_added_at, unixepoch(m.created_at) * 1000) DESC NULLS LAST, m.file_path'
    case 'updatedAt':
      return 'COALESCE(m.file_modified_at, unixepoch(m.updated_at) * 1000) DESC NULLS LAST, m.file_path'
    case 'size':
      return 'm.file_size DESC, m.file_path'
    case 'rating':
      return 'm.rating DESC NULLS LAST, m.file_path'
    case 'scriptCount':
      return `${'(SELECT COUNT(*) FROM script_version sv WHERE sv.media_id = m.id)'} DESC, m.file_path`
    default:
      return 'm.file_path'
  }
}
