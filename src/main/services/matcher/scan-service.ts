import { EventEmitter } from 'node:events'
import { AppError, type AppErrorCode } from '@shared/errors'
import type { MatchScanStatus } from '@shared/schemas/post-match'
import {
  applyPostMetadata,
  getPostMatchState,
  listStartedLibraries,
  setPostMatchState
} from '../library/library-manager'
import { videoAuthorFromTitle } from './author'
import { clearQueue, recordEntry, queueCounts } from './match-store'
import { findPostForMedia } from './match-service'

/**
 * The library-wide pass that looks for every entry's forum post.
 *
 * It is slow by construction — one entry costs one to four forum searches at
 * one every couple of seconds — so it is built to be left running and
 * interrupted rather than waited on: pause, resume, stop, and a resume after
 * an app restart that costs nothing because finished entries are simply not in
 * the worklist any more.
 *
 * Only `certain` gets applied without being asked. Everything else lands in
 * the review queue, which is what the user actually spends their time on.
 */

interface ScanEvents {
  progress: [MatchScanStatus]
}

class TypedEmitter extends EventEmitter {
  emit<K extends keyof ScanEvents>(event: K, ...args: ScanEvents[K]): boolean {
    return super.emit(event, ...args)
  }
  on<K extends keyof ScanEvents>(event: K, listener: (...args: ScanEvents[K]) => void): this {
    return super.on(event, listener)
  }
}

export const scanEvents = new TypedEmitter()

interface WorkItem {
  libraryId: string
  mediaId: string
  filePath: string
}

let running = false
let paused = false
let stopRequested = false
let status: MatchScanStatus = idleStatus()

function idleStatus(): MatchScanStatus {
  const counts = queueCounts()
  return {
    running: false,
    paused: false,
    total: 0,
    scanned: 0,
    applied: 0,
    queued: counts.queued,
    none: 0,
    currentPath: '',
    error: null
  }
}

function publish(): void {
  scanEvents.emit('progress', { ...status })
}

export function scanStatus(): MatchScanStatus {
  return running ? { ...status } : { ...idleStatus(), error: status.error }
}

export function pauseScan(): void {
  if (!running) return
  paused = true
  status.paused = true
  publish()
}

export function resumeScan(): void {
  if (!running) return
  paused = false
  status.paused = false
  status.error = null
  publish()
}

export function stopScan(): void {
  stopRequested = true
  paused = false
}

/** Wait out a pause, and report whether the run should carry on at all. */
async function waitWhilePaused(): Promise<boolean> {
  while (paused && !stopRequested) {
    await new Promise((r) => setTimeout(r, 400))
  }
  return !stopRequested
}

function buildWorklist(libraryIds: string[]): WorkItem[] {
  const wanted = new Set(libraryIds)
  const items: WorkItem[] = []
  for (const { libraryId, db } of listStartedLibraries()) {
    if (wanted.size > 0 && !wanted.has(libraryId)) continue
    for (const row of db.idsWithoutPostSource()) {
      items.push({ libraryId, mediaId: row.id, filePath: row.filePath })
    }
  }
  return items
}

/**
 * Errors that end the pass rather than the entry.
 *
 * A dead session or a rate limit will not fix itself on the next entry, and
 * carrying on would mark two thousand entries "nothing found" for a reason
 * that has nothing to do with them — which is worse than stopping, because the
 * record of it lands in every sidecar.
 */
const FATAL: AppErrorCode[] = ['scrape_login_required', 'scrape_rate_limited']

function fatalCode(e: unknown): AppErrorCode | null {
  if (e instanceof AppError && FATAL.includes(e.code)) return e.code
  return null
}

export interface StartScanOptions {
  /** Empty means every started library. */
  libraryIds: string[]
  /** Look again at entries a previous pass already settled. */
  rescan: boolean
}

export async function startScan(options: StartScanOptions): Promise<void> {
  if (running) return
  if (options.rescan) clearQueue()

  const worklist = buildWorklist(options.libraryIds)
  running = true
  paused = false
  stopRequested = false
  status = {
    running: true,
    paused: false,
    total: worklist.length,
    scanned: 0,
    applied: 0,
    queued: queueCounts().queued,
    none: 0,
    currentPath: '',
    error: null
  }
  publish()

  try {
    for (const item of worklist) {
      if (!(await waitWhilePaused())) break

      // Skipping here rather than when the worklist is built: a pass over two
      // thousand entries would otherwise open two thousand sidecars before the
      // first search, and the user would watch nothing happen for a while.
      if (!options.rescan) {
        const already = await getPostMatchState(item.libraryId, item.mediaId)
        if (already?.checkedAt) {
          status.scanned += 1
          continue
        }
      }

      status.currentPath = item.filePath
      publish()

      try {
        await scanOne(item)
      } catch (e) {
        const fatal = fatalCode(e)
        if (fatal) {
          status.error = fatal
          paused = true
          status.paused = true
          publish()
          if (!(await waitWhilePaused())) break
          continue
        }
        // One entry failing is not the run failing; it stays unchecked and a
        // later pass picks it up again.
        console.warn(`[match] ${item.filePath}: ${String(e)}`)
      }

      status.scanned += 1
      publish()
    }
  } finally {
    running = false
    paused = false
    status.running = false
    status.paused = false
    status.currentPath = ''
    publish()
  }
}

async function scanOne(item: WorkItem): Promise<void> {
  const result = await findPostForMedia(item.libraryId, item.mediaId)
  const state = await getPostMatchState(item.libraryId, item.mediaId)
  const dismissed = new Set(state?.dismissed ?? [])
  const candidates = result.candidates.filter((c) => !dismissed.has(c.topicId))

  const certain = candidates.filter((c) => c.tier === 'certain')
  if (certain.length === 1) {
    const winner = certain[0]!
    await applyPostMetadata(
      item.libraryId,
      item.mediaId,
      {
        title: winner.title,
        tags: winner.tags,
        postUrl: winner.url,
        author: winner.author,
        videoAuthor: videoAuthorFromTitle(winner.title, winner.tags)
      },
      true
    )
    await setPostMatchState(item.libraryId, item.mediaId, { auto: winner.topicId })
    recordEntry({
      libraryId: item.libraryId,
      mediaId: item.mediaId,
      filePath: item.filePath,
      title: winner.title,
      durationMs: null,
      state: 'applied',
      candidates: [winner]
    })
    status.applied += 1
    return
  }

  await setPostMatchState(item.libraryId, item.mediaId, {})
  recordEntry({
    libraryId: item.libraryId,
    mediaId: item.mediaId,
    filePath: item.filePath,
    title: null,
    durationMs: null,
    state: candidates.length > 0 ? 'queued' : 'none',
    candidates
  })
  if (candidates.length > 0) status.queued += 1
  else status.none += 1
}
