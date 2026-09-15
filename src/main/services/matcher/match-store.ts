import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import Database from 'better-sqlite3'
import type { PostCandidate } from '@shared/schemas/post-match'

/**
 * The review queue for library-wide post matching.
 *
 * In userData rather than a library's index.db, for the same reason the
 * download queue is: index.db is a derived cache and gets deleted and rebuilt
 * whenever its schema moves, while this queue costs thousands of forum
 * searches to produce. Losing it would mean asking the forum for all of it
 * again.
 *
 * What it holds is still derived — candidates and scores — so it may be
 * discarded deliberately. The judgements it must never hold live in the
 * sidecar (`postMatch`).
 */

const SCHEMA_VERSION = 1

const SCHEMA = `
CREATE TABLE match_entry (
  library_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  -- Kept here rather than joined from the library index: entries span several
  -- libraries and each has its own database, so the queue cannot join at all.
  file_path TEXT NOT NULL,
  title TEXT,
  duration_ms INTEGER,
  state TEXT NOT NULL,            -- queued | applied | none
  best_score REAL NOT NULL DEFAULT 0,
  scanned_at TEXT NOT NULL,
  PRIMARY KEY (library_id, media_id)
);
CREATE INDEX IF NOT EXISTS idx_match_entry_state ON match_entry(state, best_score DESC);

CREATE TABLE match_candidate (
  library_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  topic_id INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  payload TEXT NOT NULL,          -- the PostCandidate, as the renderer needs it
  PRIMARY KEY (library_id, media_id, topic_id)
);
CREATE INDEX IF NOT EXISTS idx_match_candidate_entry
  ON match_candidate(library_id, media_id, rank);
`

let db: Database.Database | null = null

function handle(): Database.Database {
  if (db) return db
  const dbPath = join(app.getPath('userData'), 'post-match.db')
  mkdirSync(dirname(dbPath), { recursive: true })
  const opened = new Database(dbPath)
  opened.pragma('journal_mode = WAL')
  const version = opened.pragma('user_version', { simple: true }) as number
  if (version === 0) opened.exec(SCHEMA)
  opened.pragma(`user_version = ${SCHEMA_VERSION}`)
  db = opened
  return db
}

export function closeMatchStore(): void {
  db?.close()
  db = null
}

export type EntryState = 'queued' | 'applied' | 'none'

export interface QueueEntry {
  libraryId: string
  mediaId: string
  filePath: string
  title: string | null
  durationMs: number | null
  state: EntryState
  bestScore: number
  scannedAt: string
  candidates: PostCandidate[]
}

export interface RecordedEntry {
  libraryId: string
  mediaId: string
  filePath: string
  title: string | null
  durationMs: number | null
  state: EntryState
  candidates: PostCandidate[]
}

/** Replace everything known about one entry. Re-scanning must not accumulate. */
export function recordEntry(entry: RecordedEntry): void {
  const database = handle()
  const best = entry.candidates[0]?.score ?? 0
  const write = database.transaction(() => {
    database
      .prepare(
        `INSERT INTO match_entry
           (library_id, media_id, file_path, title, duration_ms, state, best_score, scanned_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(library_id, media_id) DO UPDATE SET
           file_path = excluded.file_path, title = excluded.title,
           duration_ms = excluded.duration_ms, state = excluded.state,
           best_score = excluded.best_score, scanned_at = excluded.scanned_at`
      )
      .run(
        entry.libraryId,
        entry.mediaId,
        entry.filePath,
        entry.title,
        entry.durationMs,
        entry.state,
        best,
        new Date().toISOString()
      )
    database
      .prepare('DELETE FROM match_candidate WHERE library_id = ? AND media_id = ?')
      .run(entry.libraryId, entry.mediaId)
    const insert = database.prepare(
      `INSERT INTO match_candidate (library_id, media_id, topic_id, rank, payload)
       VALUES (?, ?, ?, ?, ?)`
    )
    entry.candidates.forEach((candidate, rank) => {
      insert.run(
        entry.libraryId,
        entry.mediaId,
        candidate.topicId,
        rank,
        JSON.stringify(candidate)
      )
    })
  })
  write()
}

interface EntryRow {
  library_id: string
  media_id: string
  file_path: string
  title: string | null
  duration_ms: number | null
  state: EntryState
  best_score: number
  scanned_at: string
}

function withCandidates(rows: EntryRow[]): QueueEntry[] {
  const database = handle()
  const select = database.prepare(
    `SELECT payload FROM match_candidate
      WHERE library_id = ? AND media_id = ? ORDER BY rank`
  )
  return rows.map((row) => ({
    libraryId: row.library_id,
    mediaId: row.media_id,
    filePath: row.file_path,
    title: row.title,
    durationMs: row.duration_ms,
    state: row.state,
    bestScore: row.best_score,
    scannedAt: row.scanned_at,
    candidates: (select.all(row.library_id, row.media_id) as { payload: string }[])
      .map((c) => {
        try {
          return JSON.parse(c.payload) as PostCandidate
        } catch {
          return null
        }
      })
      .filter((c): c is PostCandidate => c !== null)
  }))
}

/** Entries still waiting to be looked at, best evidence first. */
export function listQueue(limit: number, offset: number): QueueEntry[] {
  const rows = handle()
    .prepare(
      `SELECT * FROM match_entry WHERE state = 'queued'
        ORDER BY best_score DESC, file_path LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as EntryRow[]
  return withCandidates(rows)
}

/**
 * One candidate as it was scored.
 *
 * Applying a match reads it from here rather than taking it from the renderer:
 * what goes into a sidecar should be what the app decided, not what a message
 * says it decided.
 */
export function getCandidate(
  libraryId: string,
  mediaId: string,
  topicId: number
): PostCandidate | null {
  const row = handle()
    .prepare(
      'SELECT payload FROM match_candidate WHERE library_id = ? AND media_id = ? AND topic_id = ?'
    )
    .get(libraryId, mediaId, topicId) as { payload: string } | undefined
  if (!row) return null
  try {
    return JSON.parse(row.payload) as PostCandidate
  } catch {
    return null
  }
}

export function queueCounts(): { queued: number; applied: number; none: number } {
  const rows = handle()
    .prepare('SELECT state, COUNT(*) AS n FROM match_entry GROUP BY state')
    .all() as { state: EntryState; n: number }[]
  const counts = { queued: 0, applied: 0, none: 0 }
  for (const row of rows) counts[row.state] = row.n
  return counts
}

/** Off the queue — decided, one way or the other. */
export function settleEntry(libraryId: string, mediaId: string, state: EntryState): void {
  const database = handle()
  const settle = database.transaction(() => {
    database
      .prepare('UPDATE match_entry SET state = ? WHERE library_id = ? AND media_id = ?')
      .run(state, libraryId, mediaId)
    database
      .prepare('DELETE FROM match_candidate WHERE library_id = ? AND media_id = ?')
      .run(libraryId, mediaId)
  })
  settle()
}

/** Drop one candidate; the entry stays queued if others remain. */
export function dropCandidate(libraryId: string, mediaId: string, topicId: number): number {
  const database = handle()
  database
    .prepare(
      'DELETE FROM match_candidate WHERE library_id = ? AND media_id = ? AND topic_id = ?'
    )
    .run(libraryId, mediaId, topicId)
  const left = database
    .prepare(
      'SELECT COUNT(*) AS n FROM match_candidate WHERE library_id = ? AND media_id = ?'
    )
    .get(libraryId, mediaId) as { n: number }
  if (left.n === 0) settleEntry(libraryId, mediaId, 'none')
  return left.n
}

/** Everything this queue holds, for a fresh run or a deliberate reset. */
export function clearQueue(): void {
  const database = handle()
  const clear = database.transaction(() => {
    database.exec('DELETE FROM match_candidate')
    database.exec('DELETE FROM match_entry')
  })
  clear()
}
