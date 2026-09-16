import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import Database from 'better-sqlite3'
import type { DownloadJob, DownloadState } from '@shared/schemas/download'

/**
 * Download job persistence.
 *
 * Deliberately NOT in a library's index.db: that file is a derived cache and
 * is deleted and rebuilt whenever it fails to open or its schema version moves.
 * A queue is nobody's derivative — losing it loses the user's work — so it gets its own database in userData, and a job records
 * which library it targets instead of living inside one.
 *
 * Only the source URL is stored, never a resolved direct link: those are
 * short-lived and re-resolved just in time.
 */

// Bumped when SCHEMA changes. It is only a marker now: what actually drives
// migration is which columns the file has (see healColumns), because a version
// number can be forgotten and the table cannot.
//
// Not bumped for columns that are only added: an older build refuses a file
// with a higher number outright, yet reads and writes this table correctly
// with extra columns in it — so bumping would lock the user out of going back
// a version for nothing.
const SCHEMA_VERSION = 3

const SCHEMA = `
CREATE TABLE download_job (
  id TEXT PRIMARY KEY,
  source_url TEXT NOT NULL,
  hoster TEXT NOT NULL,
  library_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  -- 1 = the caller named this file (a forum post knows better than the URL,
  -- which is just a content hash); resolve()/Content-Disposition must not win.
  name_pinned INTEGER NOT NULL DEFAULT 0,
  part_path TEXT NOT NULL,
  file_path TEXT,
  state TEXT NOT NULL,
  bytes_downloaded INTEGER NOT NULL DEFAULT 0,
  total_bytes INTEGER,
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  -- Jobs enqueued together from one forum post share a batch; post-download
  -- ingest runs once, when every job in the batch has finished.
  batch_id TEXT,
  role TEXT NOT NULL DEFAULT 'other',   -- video / script / other
  duplicate_of TEXT,                    -- library path of an identical media
  cooldown_until TEXT,                  -- parked until this time (mega over quota)
  -- The library entry this file belongs to: an entry still waiting for its
  -- video (filled the moment the file lands), or the one ingest filed it into.
  media_id TEXT,
  -- 1 = ingest has dealt with this file; a later pass leaves it alone.
  ingested INTEGER NOT NULL DEFAULT 0,
  -- 1 = a script from a post with several videos that could not be told
  -- apart by name; it waits for the user to say which video it goes with.
  awaiting_pair INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  scraped_metadata_json TEXT            -- the post, on every job of the batch
);
CREATE INDEX IF NOT EXISTS idx_download_job_state ON download_job(state);
CREATE INDEX IF NOT EXISTS idx_download_job_batch ON download_job(batch_id);
`

interface JobRow {
  id: string
  source_url: string
  hoster: string
  library_id: string
  file_name: string
  name_pinned: number
  part_path: string
  file_path: string | null
  state: string
  bytes_downloaded: number
  total_bytes: number | null
  error: string | null
  attempts: number
  batch_id: string | null
  role: string
  duplicate_of: string | null
  cooldown_until: string | null
  media_id: string | null
  ingested: number
  awaiting_pair: number
  created_at: string
  updated_at: string
  scraped_metadata_json: string | null
}

/** A job plus the fields only the queue needs (kept off the renderer projection). */
export interface JobRecord extends DownloadJob {
  partPath: string
  /** The caller named this file; nothing discovered later may rename it. */
  namePinned: boolean
  /** Serialized ScrapedPost for batch jobs; null for a plain link. */
  postJson: string | null
  /** The entry this file belongs to, once one is known. */
  mediaId: string | null
  /** Ingest has already filed this file. */
  ingested: boolean
  /** A script waiting for the user to pick its video. */
  awaitingPair: boolean
}

function toRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    sourceUrl: row.source_url,
    hoster: row.hoster,
    libraryId: row.library_id,
    fileName: row.file_name,
    namePinned: row.name_pinned === 1,
    partPath: row.part_path,
    filePath: row.file_path,
    state: row.state as DownloadState,
    bytesDownloaded: row.bytes_downloaded,
    totalBytes: row.total_bytes,
    error: row.error,
    attempts: row.attempts,
    batchId: row.batch_id,
    role: (row.role as DownloadJob['role']) ?? 'other',
    duplicateOf: row.duplicate_of,
    cooldownUntil: row.cooldown_until,
    postJson: row.scraped_metadata_json,
    mediaId: row.media_id,
    ingested: row.ingested === 1,
    awaitingPair: row.awaiting_pair === 1,
    // Filled in by the queue's projection, which is where the post JSON is
    // read; the store deliberately keeps that column opaque.
    postTitle: '',
    postUrl: '',
    postThumb: '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/**
 * Every column added to `download_job` after its first release, with the DDL to
 * add it back.
 *
 * Migration is driven by which columns the file actually has, not by
 * `user_version`. That is a correction, not a preference: several of these were
 * added straight into SCHEMA without a matching version bump, so a database
 * created before them was stamped "current" and kept the gap. It surfaced as
 * `SqliteError: table download_job has no column named name_pinned` on a real
 * user's queue.
 *
 * A version number only records what someone remembered to write down; the
 * table itself cannot be wrong. Adding a column that already exists is skipped,
 * so this list may safely include more than any one file is missing.
 */
const ADDED_COLUMNS: { name: string; ddl: string; backfill?: string }[] = [
  { name: 'name_pinned', ddl: 'ALTER TABLE download_job ADD COLUMN name_pinned INTEGER NOT NULL DEFAULT 0' },
  { name: 'batch_id', ddl: 'ALTER TABLE download_job ADD COLUMN batch_id TEXT' },
  { name: 'role', ddl: `ALTER TABLE download_job ADD COLUMN role TEXT NOT NULL DEFAULT 'other'` },
  { name: 'duplicate_of', ddl: 'ALTER TABLE download_job ADD COLUMN duplicate_of TEXT' },
  { name: 'cooldown_until', ddl: 'ALTER TABLE download_job ADD COLUMN cooldown_until TEXT' },
  { name: 'scraped_metadata_json', ddl: 'ALTER TABLE download_job ADD COLUMN scraped_metadata_json TEXT' },
  { name: 'media_id', ddl: 'ALTER TABLE download_job ADD COLUMN media_id TEXT' },
  {
    name: 'ingested',
    ddl: 'ALTER TABLE download_job ADD COLUMN ingested INTEGER NOT NULL DEFAULT 0',
    // Finished jobs from before the column existed were filed when they
    // finished; without this, retrying anything in an old batch would file
    // the rest of that batch a second time.
    backfill: `UPDATE download_job SET ingested = 1 WHERE state = 'done'`
  },
  {
    name: 'awaiting_pair',
    ddl: 'ALTER TABLE download_job ADD COLUMN awaiting_pair INTEGER NOT NULL DEFAULT 0'
  }
]

/**
 * Bring an existing table up to the current shape. Safe to run on every open:
 * it is one PRAGMA when there is nothing to do, and it heals a file whatever
 * state it was left in.
 */
function healColumns(database: Database.Database): void {
  const present = new Set(
    (database.pragma('table_info(download_job)') as { name: string }[]).map((c) => c.name)
  )
  if (present.size === 0) return // no table yet; SCHEMA creates it
  const added: string[] = []
  for (const column of ADDED_COLUMNS) {
    if (present.has(column.name)) continue
    database.exec(column.ddl)
    if (column.backfill) database.exec(column.backfill)
    added.push(column.name)
  }
  if (added.length > 0) {
    console.log(`[downloads] downloads.db: added missing column(s) ${added.join(', ')}`)
  }
}

/** Indexes are cheap to assert and were not always present either. */
function healIndexes(database: Database.Database): void {
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_download_job_state ON download_job(state);
    CREATE INDEX IF NOT EXISTS idx_download_job_batch ON download_job(batch_id);
  `)
}

let db: Database.Database | null = null

function handle(): Database.Database {
  if (db) return db
  const dbPath = join(app.getPath('userData'), 'downloads.db')
  mkdirSync(dirname(dbPath), { recursive: true })
  const opened = new Database(dbPath)
  opened.pragma('journal_mode = WAL')
  const version = opened.pragma('user_version', { simple: true }) as number
  if (version > SCHEMA_VERSION) {
    // A newer app wrote this file; downgrading would silently drop columns.
    opened.close()
    throw new Error(`downloads.db schema version ${version}, expected ${SCHEMA_VERSION}`)
  }
  if (version === 0) {
    opened.exec(SCHEMA)
  } else {
    // Migrate, never recreate: unlike index.db these rows are not derived from
    // anything, so losing them loses the user's queue.
    healColumns(opened)
    healIndexes(opened)
  }
  opened.pragma(`user_version = ${SCHEMA_VERSION}`)
  db = opened
  return db
}

export function closeStore(): void {
  db?.close()
  db = null
}

export interface NewJob {
  id: string
  sourceUrl: string
  hoster: string
  libraryId: string
  fileName: string
  partPath: string
  namePinned?: boolean
  batchId?: string
  role?: DownloadJob['role']
  postJson?: string
  mediaId?: string
}

export function insert(job: NewJob): JobRecord {
  const now = new Date().toISOString()
  handle()
    .prepare(
      `INSERT INTO download_job
         (id, source_url, hoster, library_id, file_name, name_pinned, part_path,
          batch_id, role, scraped_metadata_json, media_id, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    )
    .run(
      job.id,
      job.sourceUrl,
      job.hoster,
      job.libraryId,
      job.fileName,
      job.namePinned ? 1 : 0,
      job.partPath,
      job.batchId ?? null,
      job.role ?? 'other',
      job.postJson ?? null,
      job.mediaId ?? null,
      now,
      now
    )
  return get(job.id)!
}

export function get(id: string): JobRecord | null {
  const row = handle().prepare('SELECT * FROM download_job WHERE id = ?').get(id) as
    | JobRow
    | undefined
  return row ? toRecord(row) : null
}

export function list(): JobRecord[] {
  const rows = handle()
    .prepare('SELECT * FROM download_job ORDER BY created_at ASC')
    .all() as JobRow[]
  return rows.map(toRecord)
}

/** Display order for the queue: the last job the user added stays in reach. */
export function listNewestFirst(): JobRecord[] {
  const rows = handle()
    .prepare('SELECT * FROM download_job ORDER BY created_at DESC, rowid DESC')
    .all() as JobRow[]
  return rows.map(toRecord)
}

/** Every job enqueued together from one post. */
export function listBatch(batchId: string): JobRecord[] {
  const rows = handle()
    .prepare('SELECT * FROM download_job WHERE batch_id = ? ORDER BY created_at ASC')
    .all(batchId) as JobRow[]
  return rows.map(toRecord)
}

/** Oldest pending job whose hoster is not in `busyHosters`. */
export function nextPending(busyHosters: Set<string>): JobRecord | null {
  for (const row of handle()
    .prepare(`SELECT * FROM download_job WHERE state = 'pending' ORDER BY created_at ASC`)
    .all() as JobRow[]) {
    if (!busyHosters.has(row.hoster)) return toRecord(row)
  }
  return null
}

export type JobPatch = Partial<
  Pick<
    JobRecord,
    | 'state'
    | 'bytesDownloaded'
    | 'totalBytes'
    | 'error'
    | 'attempts'
    | 'fileName'
    | 'filePath'
    | 'duplicateOf'
    | 'cooldownUntil'
    | 'mediaId'
    | 'ingested'
    | 'awaitingPair'
  >
>

const COLUMN: Record<keyof JobPatch, string> = {
  state: 'state',
  bytesDownloaded: 'bytes_downloaded',
  totalBytes: 'total_bytes',
  error: 'error',
  attempts: 'attempts',
  fileName: 'file_name',
  filePath: 'file_path',
  duplicateOf: 'duplicate_of',
  cooldownUntil: 'cooldown_until',
  mediaId: 'media_id',
  ingested: 'ingested',
  awaitingPair: 'awaiting_pair'
}

/** SQLite has no boolean; the driver refuses one outright. */
function bindable(value: JobPatch[keyof JobPatch]): string | number | null {
  if (typeof value === 'boolean') return value ? 1 : 0
  return value ?? null
}

export function update(id: string, patch: JobPatch): void {
  const keys = Object.keys(patch) as (keyof JobPatch)[]
  if (keys.length === 0) return
  const assignments = keys.map((k) => `${COLUMN[k]} = ?`).join(', ')
  handle()
    .prepare(`UPDATE download_job SET ${assignments}, updated_at = ? WHERE id = ?`)
    .run(...keys.map((k) => bindable(patch[k])), new Date().toISOString(), id)
}

export function remove(id: string): void {
  handle().prepare('DELETE FROM download_job WHERE id = ?').run(id)
}

/**
 * Clear finished jobs — except a script still waiting to be paired: the row is
 * the only record of which post it came from and which videos it could go with.
 */
export function removeFinished(): string[] {
  const finished = `state = 'done' AND awaiting_pair = 0`
  const ids = (
    handle().prepare(`SELECT id FROM download_job WHERE ${finished}`).all() as { id: string }[]
  ).map((r) => r.id)
  handle().prepare(`DELETE FROM download_job WHERE ${finished}`).run()
  return ids
}

/** Scripts waiting for the user to pick their video, oldest first. */
export function listAwaitingPair(): JobRecord[] {
  const rows = handle()
    .prepare(
      `SELECT * FROM download_job WHERE awaiting_pair = 1 AND state = 'done' ORDER BY created_at ASC`
    )
    .all() as JobRow[]
  return rows.map(toRecord)
}

/**
 * Startup recovery: a job marked running was interrupted by a crash or quit.
 * It becomes paused rather than pending — the user decides whether unfinished
 * work resumes, and its .part file is still on disk to continue from.
 */
export function demoteInterrupted(): number {
  return handle()
    .prepare(
      `UPDATE download_job SET state = 'paused', updated_at = ? WHERE state = 'running'`
    )
    .run(new Date().toISOString()).changes
}
