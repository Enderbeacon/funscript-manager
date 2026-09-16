import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { copyFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { shell } from 'electron'
import chokidar, { type FSWatcher } from 'chokidar'
import {
  DEFAULT_COMPANION_MATCH,
  FUNSCRIPT_EXTENSION,
  LIBRARY_CACHE_DIR,
  type CompanionMatchLevel
} from '@shared/constants'
import type { RegisteredLibrary } from '@shared/schemas/app-config'
import type { MediaDetail, MediaListItem, MediaListPage, SyncProgress } from '@shared/schemas/media-index'
import {
  MEDIA_META_VERSION,
  NAME_FIELDS,
  SCRIPT_AXIS_KEYS,
  ScriptVersionSchema,
  type MediaMeta,
  type NameField,
  type ScriptVersion
} from '@shared/schemas/media-meta'
import type { FilterNode } from '@shared/schemas/taxonomy'
import { isRank } from '@shared/rank'
import { AppError, type AppErrorCode } from '@shared/errors'
import { LibraryIndexDb, isIndexCorruption, type MediaSort } from '../db/index-db'
import { disposeHeatmapPool, getHeatmapDataUrl } from '../heatmap/heatmap-service'
import { getThumbnailDataUrl } from '../thumbnails/thumbnail-service'
import { readSidecar, sidecarPathFor, writeSidecar } from './sidecar'
import {
  isMultiAxis,
  mediaBasename,
  parseFunscript,
  scriptVersionName
} from './companion-grouping'
import { axisDonor, borrowedAxes, combineAxes, inheritsAxes } from './script-axes'
import { disposeFingerprintPool } from './fingerprint'
import { normaliseNames } from '../taxonomy/taxonomy-service'
import { IgnoreList } from './ignore-list'
import { scriptAuthorsUpdate } from './script-authors'
import { syncLibrary, type SyncSummary } from './scanner'

/**
 * Per-library lifecycle: index.db handle + startup sync + chokidar watcher.
 *
 * Runtime strategy: watcher events do not patch the index directly; they
 * schedule a debounced re-run of the diff sync (scanner.ts). The diff sync
 * is cheap (mtime/size comparisons; fingerprints only for new files) and
 * gives one code path for add/change/unlink/move — including the
 * detection of a move as an unlink followed by an add of the same fingerprint.
 */

const RESYNC_DEBOUNCE_MS = 1500

/** Windows separator, spelled out so relative paths normalise to forward slashes. */
const PATH_SEP = String.fromCharCode(92)

interface LibraryHandle {
  library: RegisteredLibrary
  db: LibraryIndexDb
  /**
   * Entries removed from the library with their files left on disk. Held on
   * the handle rather than re-read per operation because both the scanner and
   * the delete path write to it, and two readers of the same file racing would
   * lose one of the removals.
   */
  ignored: IgnoreList
  watcher: FSWatcher | null
  /** Promise chain serializing syncs per library. */
  syncTail: Promise<void>
  /** Running + queued syncs; capped at 2 (one queued sync sees the latest state). */
  syncPending: number
  resyncTimer: NodeJS.Timeout | null
  stopped: boolean
  /** Index rebuilds this run; capped, see MAX_INDEX_REBUILDS. */
  indexRebuilds: number
}

export interface LibraryManagerEvents {
  'sync-progress': (p: SyncProgress) => void
  'media-changed': (payload: { libraryId: string }) => void
  /**
   * A library operation failed in a way the user has to act on. Emitted only
   * for failures the log alone would hide (fire-and-forget startup/add): a
   * silent failure here is an invisible one in the UI.
   */
  'sync-failed': (payload: { libraryId: string; libraryName: string; code: AppErrorCode }) => void
}

class TypedEmitter extends EventEmitter {
  override on<K extends keyof LibraryManagerEvents>(event: K, listener: LibraryManagerEvents[K]): this {
    return super.on(event, listener)
  }
  override emit<K extends keyof LibraryManagerEvents>(
    event: K,
    ...args: Parameters<LibraryManagerEvents[K]>
  ): boolean {
    return super.emit(event, ...args)
  }
}

/** Manager → IPC layer notifications (sync progress, index changes). */
export const libraryEvents = new TypedEmitter()

/**
 * Map an operation error to a user-facing code, or null when the log is
 * enough. Disk-full is the one failure that must not be silent: the index
 * rebuild and the scanner's sidecar writes both die with it, and nothing on
 * screen would otherwise explain why the library never appears.
 */
function libraryErrorCode(e: unknown): AppErrorCode | null {
  const code = (e as { code?: string } | null)?.code
  return code === 'ENOSPC' || code === 'EDQUOT' || code === 'EFBIG' || code === 'SQLITE_FULL'
    ? 'disk_full'
    : null
}

/** Fire the user-visible failure notification for a library, if warranted. */
function notifySyncFailed(library: RegisteredLibrary, e: unknown): void {
  const code = libraryErrorCode(e)
  if (code) {
    libraryEvents.emit('sync-failed', {
      libraryId: library.id,
      libraryName: library.name,
      code
    })
  }
}

/**
 * How many times one library's index may be rebuilt in a run. A rebuild that
 * comes back damaged is the disk talking, and repeating it forever would turn
 * a failing drive into a scan loop.
 */
const MAX_INDEX_REBUILDS = 2

/**
 * Throw away a library's damaged index and scan it back.
 *
 * Nothing of the user's is at stake — index.db is a cache over the sidecars —
 * so this happens without asking. It is still announced: the library goes
 * briefly empty and then refills, and that is alarming without a reason for it.
 *
 * Returns false when there is nothing to recover (no such library, or it has
 * already been rebuilt too often to keep trying).
 */
export function recoverIndex(libraryId: string): boolean {
  const handle = handles.get(libraryId)
  if (!handle || handle.stopped) return false
  if (handle.indexRebuilds >= MAX_INDEX_REBUILDS) return false
  handle.indexRebuilds += 1
  console.error(`[index] rebuilding damaged index for ${handle.library.rootPath}`)
  try {
    handle.db.rebuild()
  } catch (e) {
    console.error(`[index] rebuild failed for ${handle.library.rootPath}:`, e)
    notifySyncFailed(handle.library, e)
    return false
  }
  libraryEvents.emit('sync-failed', {
    libraryId,
    libraryName: handle.library.name,
    code: 'index_rebuilt'
  })
  void runSync(handle)
  return true
}

const handles = new Map<string, LibraryHandle>()

function watchIgnored(path: string): boolean {
  const name = basename(path)
  return (
    name.startsWith('.') || // hidden files/dirs, including LIBRARY_CACHE_DIR
    path.includes(LIBRARY_CACHE_DIR) ||
    name.endsWith('.tmp')
  )
}

function scheduleResync(handle: LibraryHandle): void {
  if (handle.stopped) return
  if (handle.resyncTimer) clearTimeout(handle.resyncTimer)
  handle.resyncTimer = setTimeout(() => {
    handle.resyncTimer = null
    void runSync(handle)
  }, RESYNC_DEBOUNCE_MS)
}

function runSync(handle: LibraryHandle): Promise<void> {
  // Coalesce: one waiting sync is enough — it will see the latest disk state.
  if (handle.stopped || handle.syncPending > 1) return handle.syncTail
  handle.syncPending += 1
  handle.syncTail = handle.syncTail.then(async () => {
    try {
      if (handle.stopped) return
      const { library, db, ignored } = handle
      await syncLibrary(library, db, ignored, (p) =>
        libraryEvents.emit('sync-progress', { libraryId: library.id, ...p })
      )
      libraryEvents.emit('media-changed', { libraryId: library.id })
    } catch (e) {
      console.error(`[library] sync failed for ${handle.library.rootPath}:`, e)
      // A damaged index cannot be scanned into; rebuilding it is what lets the
      // retry inside recoverIndex get anywhere.
      if (isIndexCorruption(e)) recoverIndex(handle.library.id)
      else notifySyncFailed(handle.library, e)
    } finally {
      handle.syncPending -= 1
    }
  })
  return handle.syncTail
}

function startWatcher(handle: LibraryHandle): void {
  const watcher = chokidar.watch(handle.library.rootPath, {
    ignored: watchIgnored,
    persistent: true,
    // The startup sync already covered the initial state.
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 100
    }
  })
  watcher.on('all', () => scheduleResync(handle))
  watcher.on('error', (err) => console.error(`[watcher] ${handle.library.rootPath}:`, err))
  handle.watcher = watcher
}

/** Open the index, run the startup sync, then start watching. */
export async function startLibrary(library: RegisteredLibrary): Promise<void> {
  if (handles.has(library.id)) return
  let handle: LibraryHandle
  try {
    handle = {
      library,
      db: LibraryIndexDb.open(library.rootPath),
      ignored: await IgnoreList.load(library.rootPath),
      watcher: null,
      syncTail: Promise.resolve(),
      syncPending: 0,
      resyncTimer: null,
      stopped: false,
      indexRebuilds: 0
    }
  } catch (e) {
    // The handle never registered, so no sync will ever run to report this.
    notifySyncFailed(library, e)
    throw e
  }
  handles.set(library.id, handle)
  try {
    await runSync(handle)
  } finally {
    if (!handle.stopped) startWatcher(handle)
  }
}

export async function stopLibrary(libraryId: string): Promise<void> {
  const handle = handles.get(libraryId)
  if (!handle) return
  handle.stopped = true
  handles.delete(libraryId)
  if (handle.resyncTimer) clearTimeout(handle.resyncTimer)
  await handle.watcher?.close().catch(() => {})
  await handle.syncTail
  handle.db.close()
}

/**
 * Resolves once the startup pass is over, however it went.
 *
 * Anything that rewrites names across the library has to wait for this: it
 * works from the index, and until a library has had its first sync the index
 * does not yet know which media carry the name. A rename running before that
 * would move the entry in the taxonomy and leave the sidecars behind.
 */
let markReady = (): void => {}
const ready = new Promise<void>((resolve) => {
  markReady = resolve
})

export function librariesReady(): Promise<void> {
  return ready
}

export function markLibrariesReady(): void {
  markReady()
}

export async function startAllLibraries(libraries: RegisteredLibrary[]): Promise<void> {
  // Sequential on purpose: parallel first-time scans would thrash the disk.
  try {
    for (const library of libraries) {
      try {
        await startLibrary(library)
      } catch (e) {
        console.error(`[library] failed to start ${library.rootPath}:`, e)
      }
    }
  } finally {
    markLibrariesReady()
  }
}

export async function disposeAllLibraries(): Promise<void> {
  await Promise.allSettled([...handles.keys()].map((id) => stopLibrary(id)))
  await disposeFingerprintPool()
  await disposeHeatmapPool()
}

function requireHandle(libraryId: string): LibraryHandle {
  const handle = handles.get(libraryId)
  if (!handle) throw new AppError('library_not_found')
  return handle
}

/** Manual full re-sync (IPC `library:sync`). */
export async function requestSync(libraryId: string): Promise<void> {
  await runSync(requireHandle(libraryId))
}

/**
 * The parts of a started library that media-lifecycle (delete, rename) needs.
 * Those operations belong in their own file — they are the only ones that
 * touch the user's files — but they act on the same handle, and there must go
 * on being exactly one of it per library.
 */
export type InternalLibraryHandle = Pick<LibraryHandle, 'library' | 'db' | 'ignored'>

export function internalHandle(libraryId: string): InternalLibraryHandle {
  return requireHandle(libraryId)
}

/**
 * The handle if the library is running, null if it is not — for reads where
 * "not started yet" is an ordinary answer rather than a failure. Libraries are
 * started one at a time (see `startAllLibraries`), so at boot the UI routinely
 * asks about a library whose first scan has not reached it yet.
 */
export function runningHandle(libraryId: string): InternalLibraryHandle | null {
  return handles.get(libraryId) ?? null
}

/** Tell the UI the index moved, for writes that bypass commitSidecar. */
export function notifyMediaChanged(libraryId: string): void {
  libraryEvents.emit('media-changed', { libraryId })
}

/** Library root + relative path of one media item (for playback etc.). */
export function getMediaLocation(
  libraryId: string,
  mediaId: string
): { libraryRoot: string; mediaRelPath: string } {
  const handle = requireHandle(libraryId)
  const relPath = handle.db.getMediaRelPath(mediaId)
  if (!relPath) throw new AppError('media_not_found')
  return { libraryRoot: handle.library.rootPath, mediaRelPath: relPath }
}

/** Heatmap PNG data URL for a media item's (default) script version. */
export function getHeatmap(
  libraryId: string,
  mediaId: string,
  scriptVersionId?: string
): Promise<string | null> {
  const handle = requireHandle(libraryId)
  const relPath = handle.db.getMediaRelPath(mediaId)
  if (!relPath) return Promise.resolve(null)
  return getHeatmapDataUrl({
    libraryRoot: handle.library.rootPath,
    mediaId,
    mediaRelPath: relPath,
    scriptVersionId
  })
}

/** Thumbnail JPEG data URL for a media item (null for audio/missing files). */
export function getThumbnail(libraryId: string, mediaId: string): Promise<string | null> {
  const handle = requireHandle(libraryId)
  const relPath = handle.db.getMediaRelPath(mediaId)
  if (!relPath) return Promise.resolve(null)
  return getThumbnailDataUrl({
    libraryRoot: handle.library.rootPath,
    mediaId,
    mediaRelPath: relPath
  })
}

/**
 * Sidecar → detail projection (the sidecar is the source of truth).
 *
 * `addedAt` is the one thing the sidecar cannot answer — it is the file's own
 * arrival time, which only the index has been to the disk for — so the caller
 * brings it and the page shows the same date the grid sorts by.
 */
function toDetail(
  libraryId: string,
  relPath: string,
  mediaAbs: string,
  meta: MediaMeta,
  addedAt: number | null
): MediaDetail {
  return {
    id: meta.id,
    libraryId,
    filePath: relPath,
    fileName: relPath.split('/').pop() ?? relPath,
    title: meta.title ?? null,
    fileSize: meta.fileFingerprint.size,
    absPath: mediaAbs,
    createdAt: addedAt !== null ? new Date(addedAt).toISOString() : meta.createdAt,
    fingerprint: meta.fileFingerprint.blake3Head,
    durationMs: meta.mediaInfo?.durationMs ?? null,
    resolution:
      meta.mediaInfo?.width && meta.mediaInfo?.height
        ? `${meta.mediaInfo.width}×${meta.mediaInfo.height}`
        : null,
    codec: [meta.mediaInfo?.videoCodec, meta.mediaInfo?.audioCodec].filter(Boolean).join(" / ") || null,
    missing: !existsSync(mediaAbs),
    // A placeholder is not a lost file: it has never arrived, and the page
    // offers a way to supply it rather than a warning about a broken library.
    wanted: meta.wanted ? { sources: meta.wanted.sources } : null,
    postLinks: meta.postLinks,
    tags: meta.tags,
    videoAuthors: meta.videoAuthors,
    scriptAuthors: meta.scriptAuthors,
    studios: meta.studios,
    playlists: meta.playlists,
    scriptVersions: meta.scriptVersions.map((v) => ({
      id: v.id,
      name: v.name,
      author: v.author ?? null,
      isDefault: v.isDefault ?? false,
      isMultiAxis: isMultiAxis(v),
      axes: SCRIPT_AXIS_KEYS.filter((a) => v.files[a] !== undefined),
      files: SCRIPT_AXIS_KEYS.map((a) => v.files[a]).filter((f): f is string => f !== undefined),
      canInheritAxes: !isMultiAxis(v) && axisDonor(meta, v) !== null,
      inheritAxes: inheritsAxes(meta, v),
      borrowedAxes: borrowedAxes(meta, v),
      inheritedFrom: inheritsAxes(meta, v) ? (axisDonor(meta, v)?.name ?? null) : null,
      sourceUrl: v.sourceUrl ?? null,
      notes: v.notes ?? null
    })),
    subtitles: meta.subtitles.map((s) => ({ language: s.language ?? null, path: s.path })),
    sources: meta.sources.map((s) => ({ type: s.type, url: s.url })),
    lastUsedScriptVersionId: meta.userMeta.lastUsedScriptVersionId ?? null,
    favorite: meta.userMeta.favorite ?? false,
    rating: meta.userMeta.rating ?? null,
    notes: meta.userMeta.notes ?? null
  }
}

/**
 * Full media detail for the detail page, built fresh from the sidecar (source
 * of truth). Null when the id is unknown or its sidecar is unreadable. The
 * missing flag is re-checked against disk here so the page is always current.
 */
export async function getMediaDetail(
  libraryId: string,
  mediaId: string
): Promise<MediaDetail | null> {
  const handle = requireHandle(libraryId)
  const relPath = handle.db.getMediaRelPath(mediaId)
  if (!relPath) return null
  const mediaAbs = join(handle.library.rootPath, relPath)
  const sidecar = await readSidecar(sidecarPathFor(mediaAbs))
  if (!sidecar.ok) return null
  return toDetail(libraryId, relPath, mediaAbs, sidecar.meta, handle.db.fileAddedAt(mediaId))
}

interface EditTarget {
  handle: LibraryHandle
  relPath: string
  mediaAbs: string
  meta: MediaMeta
}

/** Locate + read the sidecar for an edit; throws when it is unusable. */
async function openForEdit(libraryId: string, mediaId: string): Promise<EditTarget> {
  const handle = requireHandle(libraryId)
  const relPath = handle.db.getMediaRelPath(mediaId)
  if (!relPath) throw new AppError('media_not_found')
  const mediaAbs = join(handle.library.rootPath, relPath)
  const sidecar = await readSidecar(sidecarPathFor(mediaAbs))
  if (!sidecar.ok) throw new AppError('media_not_found')
  return { handle, relPath, mediaAbs, meta: sidecar.meta }
}

/**
 * Write an edited sidecar and refresh the derived index right away, so the UI
 * does not have to wait for the watcher's debounced re-sync.
 */
/**
 * A rank only means something for a playlist the media is actually in.
 *
 * Membership and order are separate fields — which is what lets a playlist stay
 * an ordinary name list — so they can drift apart: a name taken off by the
 * detail panel's ✕, a playlist renamed, a hand-edited sidecar. Rather than ask
 * every one of those call sites to remember the other half, the two are
 * reconciled on the way to disk, which is the one path all of them share.
 *
 * Ranks are re-keyed to the spelling `playlists` actually carries, so a rename
 * that only changed case keeps the order it had.
 */
function reconcileRanks(meta: MediaMeta): MediaMeta {
  const byLower = new Map<string, string>()
  for (const [name, rank] of Object.entries(meta.playlistRanks)) {
    if (isRank(rank)) byLower.set(name.toLowerCase(), rank)
  }
  const ranks: Record<string, string> = {}
  for (const name of meta.playlists) {
    const rank = byLower.get(name.toLowerCase())
    if (rank !== undefined) ranks[name] = rank
  }
  const unchanged =
    Object.keys(ranks).length === Object.keys(meta.playlistRanks).length &&
    Object.entries(ranks).every(([name, rank]) => meta.playlistRanks[name] === rank)
  return unchanged ? meta : { ...meta, playlistRanks: ranks }
}

async function commitSidecar(target: EditTarget, raw: MediaMeta): Promise<MediaDetail> {
  const meta = reconcileRanks(raw)
  const { handle, relPath, mediaAbs } = target
  const sidecarPath = sidecarPathFor(mediaAbs)
  await writeSidecar(sidecarPath, meta)
  try {
    handle.db.upsertFromSidecar(meta, relPath, Math.floor((await stat(sidecarPath)).mtimeMs))
  } catch (e) {
    // The index is a disposable cache: a failed refresh is fixed by the
    // watcher's re-sync, so the sidecar write still stands.
    console.error(`[library] index refresh failed for ${relPath}:`, e)
  }
  libraryEvents.emit('media-changed', { libraryId: handle.library.id })
  return toDetail(handle.library.id, relPath, mediaAbs, meta, handle.db.fileAddedAt(meta.id))
}

export type MediaEditor = (meta: MediaMeta) => MediaMeta

/**
 * Read a sidecar, hand it to `edit`, write back what comes out. Every metadata
 * change goes through here so there is exactly one place that knows the order:
 * sidecar first, index second, event last.
 */
export async function editMedia(
  libraryId: string,
  mediaId: string,
  edit: MediaEditor
): Promise<MediaDetail> {
  const target = await openForEdit(libraryId, mediaId)
  return commitSidecar(target, edit(target.meta))
}

/**
 * What matching has already established about an entry, straight off the
 * sidecar. Not part of `MediaDetail`: the panel has no use for it, and the
 * matcher needs it before it decides to look at this entry at all.
 */
export async function getPostMatchState(
  libraryId: string,
  mediaId: string
): Promise<MediaMeta['postMatch']> {
  const target = await openForEdit(libraryId, mediaId).catch(() => null)
  return target?.meta.postMatch
}

/** Record that the forum has been searched for this entry, and what came of it. */
export async function setPostMatchState(
  libraryId: string,
  mediaId: string,
  patch: { dismiss?: number; auto?: number }
): Promise<void> {
  await editMedia(libraryId, mediaId, (meta) => {
    const previous = meta.postMatch
    const dismissed = new Set(previous?.dismissed ?? [])
    if (patch.dismiss !== undefined) dismissed.add(patch.dismiss)
    return {
      ...meta,
      postMatch: {
        checkedAt: new Date().toISOString(),
        dismissed: [...dismissed],
        ...(patch.auto !== undefined ? { auto: patch.auto } : previous?.auto !== undefined ? { auto: previous.auto } : {})
      },
      updatedAt: new Date().toISOString()
    }
  })
}

/** Libraries currently open, for the operations that sweep all of them. */
export function listStartedLibraries(): { libraryId: string; db: LibraryIndexDb }[] {
  return [...handles.values()].map((h) => ({ libraryId: h.library.id, db: h.db }))
}

/** Detail-page action: make one script version this media's default. */
export async function setDefaultScriptVersion(
  libraryId: string,
  mediaId: string,
  scriptVersionId: string
): Promise<MediaDetail> {
  const target = await openForEdit(libraryId, mediaId)
  const { meta } = target
  if (!meta.scriptVersions.some((v) => v.id === scriptVersionId)) {
    throw new AppError('script_version_not_found')
  }
  return commitSidecar(target, {
    ...meta,
    scriptVersions: meta.scriptVersions.map((v) => ({ ...v, isDefault: v.id === scriptVersionId })),
    updatedAt: new Date().toISOString()
  })
}

/**
 * Detail-page action: turn "borrow the other axes from the default multi-axis
 * version" on or off for one single-axis version.
 */
export async function setVersionInheritAxes(
  libraryId: string,
  mediaId: string,
  scriptVersionId: string,
  inherit: boolean
): Promise<MediaDetail> {
  const target = await openForEdit(libraryId, mediaId)
  const { meta } = target
  if (!meta.scriptVersions.some((v) => v.id === scriptVersionId)) {
    throw new AppError('script_version_not_found')
  }
  return commitSidecar(target, {
    ...meta,
    scriptVersions: meta.scriptVersions.map((v) =>
      v.id === scriptVersionId ? { ...v, inheritAxes: inherit } : v
    ),
    updatedAt: new Date().toISOString()
  })
}

/** Reject a source URL before it can reach writeSidecar as a raw ZodError. */
function assertSourceUrl(url: string): void {
  if (!ScriptVersionSchema.shape.sourceUrl.safeParse(url).success) {
    throw new AppError('invalid_url', { url })
  }
}

export interface ScriptVersionEdit {
  name?: string
  author?: string | null
  sourceUrl?: string | null
  notes?: string | null
}

/**
 * Detail-page action: rename a version and edit its author / source URL /
 * notes. An omitted key keeps its current value; null or
 * a blank string clears the optional field.
 */
export async function updateScriptVersion(
  libraryId: string,
  mediaId: string,
  scriptVersionId: string,
  edit: ScriptVersionEdit
): Promise<MediaDetail> {
  const target = await openForEdit(libraryId, mediaId)
  const { meta } = target
  if (!meta.scriptVersions.some((v) => v.id === scriptVersionId)) {
    throw new AppError('script_version_not_found')
  }
  const sourceUrl = edit.sourceUrl?.trim()
  if (sourceUrl) assertSourceUrl(sourceUrl)

  const apply = (version: ScriptVersion): ScriptVersion => {
    const next: ScriptVersion = { ...version }
    // A blank name is a no-op rather than a schema violation; the form
    // already refuses to submit one.
    const name = edit.name?.trim()
    if (name) next.name = name
    for (const key of ['author', 'sourceUrl', 'notes'] as const) {
      const raw = edit[key]
      if (raw === undefined) continue
      const value = raw?.trim() ?? ''
      if (value === '') delete next[key]
      else next[key] = value
    }
    return next
  }

  const scriptVersions = meta.scriptVersions.map((v) => (v.id === scriptVersionId ? apply(v) : v))
  // Typing an author into the version's form should put them in the library's
  // script-author list now, not after the next scan gets round to it.
  const withVersions = { ...meta, scriptVersions }
  const authors = scriptAuthorsUpdate(withVersions)
  if (authors !== null) await normaliseNames('scriptAuthors', authors)

  return commitSidecar(target, {
    ...withVersions,
    ...(authors !== null ? { scriptAuthors: authors } : {}),
    updatedAt: new Date().toISOString()
  })
}

/** Conventional companion filename, so a copied script still round-trips
 *  through companion grouping if the sidecar is ever lost. */
function scriptFileName(mediaBase: string, versionKey: string, axis: string): string {
  // Dots would split into extra segments and confuse the version key.
  const key = versionKey.replace(/[\\/:*?"<>|.]+/g, '-').replace(/\s+/g, '-') || 'v'
  const suffix = axis === 'main' ? '' : `.${axis}`
  return `${mediaBase}.${key}${suffix}${FUNSCRIPT_EXTENSION}`
}

export interface AddScriptVersionInput {
  name: string
  author?: string
  sourceUrl?: string
  notes?: string
  /** Axis → absolute path of an existing .funscript; `main` is required. */
  files: Partial<Record<(typeof SCRIPT_AXIS_KEYS)[number], string>>
}

export interface AddScriptVersionResult {
  detail: MediaDetail
  copied: string[]
}

/**
 * Detail-page action: add a version from funscript files the scanner would
 * never group on its own — another folder, a download dir. Scripts outside the
 * media's own directory are never grouped automatically: a name that happens
 * to match across folders is not evidence that they belong together.
 *
 * A file already under the library root is referenced where it lies; one from
 * outside is copied next to the media first, because sidecar paths are
 * media-relative and both playback paths drop anything resolving outside the
 * root. Copies never overwrite: the version key gets a `-2`, `-3`, … suffix
 * until every axis lands on a free name.
 */
export async function addScriptVersion(
  libraryId: string,
  mediaId: string,
  input: AddScriptVersionInput
): Promise<AddScriptVersionResult> {
  const target = await openForEdit(libraryId, mediaId)
  const { handle, mediaAbs, meta } = target
  const libraryRoot = handle.library.rootPath
  const mediaDir = dirname(mediaAbs)
  const mediaBase = mediaBasename(basename(mediaAbs))

  const name = input.name.trim()
  const author = input.author?.trim()
  const sourceUrl = input.sourceUrl?.trim()
  const notes = input.notes?.trim()
  if (sourceUrl) assertSourceUrl(sourceUrl)

  const picked = SCRIPT_AXIS_KEYS.map((axis) => ({ axis, src: input.files[axis] })).filter(
    (p): p is { axis: (typeof SCRIPT_AXIS_KEYS)[number]; src: string } => Boolean(p.src)
  )
  for (const { src } of picked) {
    if (!isAbsolute(src) || !existsSync(src)) {
      throw new AppError('script_file_not_found', { file: basename(src) })
    }
  }

  const isOutside = ({ src }: { src: string }): boolean => {
    const relToRoot = relative(libraryRoot, src)
    return relToRoot.startsWith('..') || isAbsolute(relToRoot)
  }
  const toCopy = picked.filter(isOutside)

  // One suffix for the whole version, so its axis files stay a matching set.
  const taken = new Set((await readdir(mediaDir).catch(() => [])).map((n) => n.toLowerCase()))
  let key = name
  for (
    let i = 2;
    toCopy.some(({ axis }) => taken.has(scriptFileName(mediaBase, key, axis).toLowerCase()));
    i++
  ) {
    key = `${name}-${i}`
  }

  const files: Record<string, string> = {}
  const copied: string[] = []
  try {
    for (const entry of picked) {
      if (!isOutside(entry)) {
        // Inside the library: reference in place. May sit above the media's own
        // folder (`../scripts/x.funscript`) — that is still inside the root.
        files[entry.axis] = relative(mediaDir, entry.src).split('\\').join('/')
        continue
      }
      const fileName = scriptFileName(mediaBase, key, entry.axis)
      await copyFile(entry.src, join(mediaDir, fileName))
      files[entry.axis] = fileName
      copied.push(fileName)
    }
  } catch (e) {
    // Half a multi-axis version copied, then a failure, would leave exactly the
    // orphan files the delete flow exists to avoid. Nothing is in the sidecar
    // yet, so undoing the copies is safe.
    for (const fileName of copied) await rm(join(mediaDir, fileName)).catch(() => {})
    throw e
  }

  const version: ScriptVersion = {
    id: randomUUID(),
    name,
    ...(author ? { author } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(notes ? { notes } : {}),
    // A media whose first version this is must have a default.
    ...(meta.scriptVersions.length === 0 ? { isDefault: true } : {}),
    files: files as ScriptVersion['files']
  }

  const detail = await commitSidecar(target, {
    ...meta,
    scriptVersions: [...meta.scriptVersions, version],
    updatedAt: new Date().toISOString()
  })
  return { detail, copied }
}

export interface DeleteScriptVersionResult {
  detail: MediaDetail
  trashed: string[]
  failed: string[]
}

/**
 * Detail-page action: drop a script version from the sidecar and send its
 * script files to the OS trash (recoverable). Grouping only runs on first
 * ingest, so leaving the files behind would strand them — but a file another
 * version still references, or one outside the library root, is never touched.
 */
export async function deleteScriptVersion(
  libraryId: string,
  mediaId: string,
  scriptVersionId: string
): Promise<DeleteScriptVersionResult> {
  const target = await openForEdit(libraryId, mediaId)
  const { handle, mediaAbs, meta } = target
  const version = meta.scriptVersions.find((v) => v.id === scriptVersionId)
  if (!version) throw new AppError('script_version_not_found')

  const libraryRoot = handle.library.rootPath
  const mediaDir = dirname(mediaAbs)
  const remaining = meta.scriptVersions.filter((v) => v.id !== scriptVersionId)
  const stillReferenced = new Set(
    remaining.flatMap((v) =>
      Object.values(v.files)
        .filter((f): f is string => Boolean(f))
        .map((f) => resolve(mediaDir, f))
    )
  )

  const trashed: string[] = []
  const failed: string[] = []
  for (const rel of Object.values(version.files)) {
    if (!rel) continue
    const abs = resolve(mediaDir, rel)
    const relToRoot = relative(libraryRoot, abs)
    if (relToRoot.startsWith('..') || isAbsolute(relToRoot)) continue // escapes the library
    if (stillReferenced.has(abs) || !existsSync(abs)) continue
    try {
      await shell.trashItem(abs)
      trashed.push(rel)
    } catch (e) {
      console.error(`[library] trash failed for ${abs}:`, e)
      failed.push(rel)
    }
  }

  // Keep the invariants the picker relies on: exactly one default survives and
  // lastUsed never points at a version that is gone.
  const needsDefault = remaining.length > 0 && !remaining.some((v) => v.isDefault)
  const scriptVersions = remaining.map((v, i) =>
    needsDefault && i === 0 ? { ...v, isDefault: true } : v
  )
  const { lastUsedScriptVersionId: lastUsed, ...restUserMeta } = meta.userMeta

  const detail = await commitSidecar(target, {
    ...meta,
    scriptVersions,
    userMeta:
      lastUsed === scriptVersionId
        ? restUserMeta
        : { ...restUserMeta, ...(lastUsed ? { lastUsedScriptVersionId: lastUsed } : {}) },
    updatedAt: new Date().toISOString()
  })
  return { detail, trashed, failed }
}

export interface ExistingMedia {
  libraryId: string
  mediaId: string
  filePath: string
  title: string | null
}

/**
 * Has any started library already got a media carrying this source URL?
 * Used before a download to tell the user "you already have this post's
 * video" instead of discovering it after several gigabytes.
 */
export function findBySourceUrl(url: string): ExistingMedia | null {
  for (const handle of handles.values()) {
    const mediaId = handle.db.findIdBySourceUrl(url)
    if (!mediaId) continue
    const relPath = handle.db.getMediaRelPath(mediaId)
    if (!relPath) continue
    return {
      libraryId: handle.library.id,
      mediaId,
      filePath: relPath,
      title: null
    }
  }
  return null
}

/**
 * Which media is this file on disk?
 *
 * Asked when a player reports a file we did not open — the user picked it
 * themselves — so that the script for it can be loaded anyway. Only libraries that are running can answer, and a file
 * outside all of them has no answer, which is a normal outcome rather than a
 * failure.
 */
export function findByAbsPath(
  absPath: string
): { libraryId: string; mediaId: string; libraryRoot: string; mediaRelPath: string } | null {
  const target = resolve(absPath)
  for (const handle of handles.values()) {
    const root = handle.library.rootPath
    const rel = relative(root, target)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue
    const relPath = rel.split(sep).join('/')
    const mediaId =
      handle.db.findIdByRelPath(relPath) ?? handle.db.findIdByRelPathInsensitive(relPath)
    if (!mediaId) continue
    return { libraryId: handle.library.id, mediaId, libraryRoot: root, mediaRelPath: relPath }
  }
  return null
}

/**
 * Is this forum topic already recorded as a source somewhere in the library?
 *
 * Asked while offering match candidates: a post that is already attached to
 * another entry is usually a collection thread covering several scenes, and
 * saying so is the difference between a useful suggestion and a puzzling one.
 */
export function findByTopicId(topicId: number): ExistingMedia | null {
  for (const handle of handles.values()) {
    const mediaId = handle.db.findIdByTopicId(topicId)
    if (!mediaId) continue
    const relPath = handle.db.getMediaRelPath(mediaId)
    if (!relPath) continue
    return { libraryId: handle.library.id, mediaId, filePath: relPath, title: null }
  }
  return null
}

/** Wait for the watcher to ingest a file we just put in the library. */
async function waitForIngest(
  handle: LibraryHandle,
  relPath: string,
  timeoutMs: number
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const id = handle.db.findIdByRelPath(relPath)
    if (id) return id
    if (Date.now() > deadline) return null
    await new Promise((r) => setTimeout(r, 500))
  }
}

export interface PostMetadata {
  title: string
  tags: string[]
  postUrl: string
  /** Whoever posted the thread — the script's author. */
  author: string
  /**
   * Whoever made the video, when the post's title says so plainly. A different
   * person from `author` far more often than not: the thread is opened by the
   * scripter, and the animation is somebody else's.
   */
  videoAuthor?: string
  /**
   * The address the file actually came down from. Kept beside the post link
   * because they answer different questions: the post is where the scene was
   * found and discussed, the download link is where this copy came from — and
   * a year later, when a mirror has died, only one of those tells you which.
   */
  downloadUrl?: string
  /**
   * Links in the post the app cannot fetch — a shop, a Patreon, an
   * unrecognised host. Filed so the detail panel can offer a way to them
   * rather than the information being lost with the post.
   */
  otherLinks?: { url: string; hoster: string; label: string }[]
}

/** Add post links we do not already have, keeping the order the post had them. */
function mergePostLinks(
  existing: MediaMeta['postLinks'],
  incoming: { url: string; hoster: string; label: string }[]
): MediaMeta['postLinks'] {
  const seen = new Set(existing.map((l) => l.url))
  const added = incoming.filter((l) => l.url && !seen.has(l.url))
  return added.length === 0 ? existing : [...existing, ...added]
}

/** What supplying a post link actually changed, so the panel can say so. */
export interface AppliedPostMetadata {
  tagsAdded: string[]
  scriptAuthorsAdded: string[]
  videoAuthorsAdded: string[]
  titleSet: boolean
  linksAdded: number
}

/**
 * Fold a post's metadata into a media the user pointed at it — the manual
 * counterpart of the download ingest, for files that arrived some other way.
 *
 * Everything is additive. A tag the media already carries is not duplicated, a
 * title the user wrote is not replaced, and nothing is ever removed: the post
 * is one more source of information about this scene, not the authority on it.
 * That is what makes the operation safe to run without a preview, and safe to
 * run twice.
 */
export async function applyPostMetadata(
  libraryId: string,
  mediaId: string,
  post: PostMetadata,
  /**
   * Let the post's title stand in for the entry's, even when the entry has one.
   *
   * Off by default, because pasting a link is something a user does to an entry
   * they may well have titled themselves. On for a match the user accepted or
   * the app resolved: there the post *is* the answer to "what is this scene
   * called", and a filename-derived title is not worth keeping over it.
   */
  overwriteTitle = false
): Promise<{ detail: MediaDetail; applied: AppliedPostMetadata }> {
  const target = await openForEdit(libraryId, mediaId)
  const { meta } = target

  const tags = await normaliseNames('tags', [...meta.tags, ...post.tags])
  const scriptAuthors = await normaliseNames('scriptAuthors', [
    ...meta.scriptAuthors,
    ...(post.author ? [post.author] : [])
  ])

  // Registered the same way every other name is, so an author the library
  // already knows under that spelling is matched rather than duplicated, and a
  // new one arrives in the filter sidebar instead of existing only here.
  const videoAuthors = await normaliseNames('videoAuthors', [
    ...meta.videoAuthors,
    ...(post.videoAuthor ? [post.videoAuthor] : [])
  ])

  const sources = [...meta.sources]
  if (post.postUrl && !sources.some((s) => s.url === post.postUrl)) {
    sources.push({ type: 'eroscripts', url: post.postUrl })
  }
  const postLinks = mergePostLinks(meta.postLinks, post.otherLinks ?? [])

  const known = new Set(meta.tags.map((n) => n.toLowerCase()))
  const knownAuthors = new Set(meta.scriptAuthors.map((n) => n.toLowerCase()))
  const knownVideoAuthors = new Set(meta.videoAuthors.map((n) => n.toLowerCase()))
  const applied: AppliedPostMetadata = {
    tagsAdded: tags.filter((n) => !known.has(n.toLowerCase())),
    scriptAuthorsAdded: scriptAuthors.filter((n) => !knownAuthors.has(n.toLowerCase())),
    videoAuthorsAdded: videoAuthors.filter((n) => !knownVideoAuthors.has(n.toLowerCase())),
    titleSet: Boolean(post.title) && (overwriteTitle || !meta.title) && post.title !== meta.title,
    linksAdded: postLinks.length - meta.postLinks.length
  }

  const detail = await commitSidecar(target, {
    ...meta,
    ...(applied.titleSet ? { title: post.title } : {}),
    tags,
    scriptAuthors,
    videoAuthors,
    postLinks,
    sources,
    updatedAt: new Date().toISOString()
  })
  return { detail, applied }
}

export interface AttachPostResult {
  mediaId: string
  /** Script versions actually added (already-grouped files are skipped). */
  addedVersions: string[]
  /** Another media with identical content, if the index knows one. */
  duplicateOf: string | null
}

/**
 * A downloaded script file and who wrote it.
 *
 * The author is not always the post's author: a thread's scripts are routinely
 * re-done by someone else further down, and that reply's poster is the author
 * of the file that came from it. Carrying it per file rather than per batch is
 * the only way that survives into the script version.
 */
export interface DownloadedScript {
  absPath: string
  author?: string
}

/**
 * Fold script files into a sidecar as script versions, grouping them the way
 * the scanner would so `clip.funscript` + `clip.roll.funscript` become one
 * multi-axis version. Shared by the two ingest paths.
 */
function groupDownloadedScripts(
  meta: MediaMeta,
  mediaAbs: string,
  scripts: DownloadedScript[],
  level: CompanionMatchLevel = DEFAULT_COMPANION_MATCH
): {
  versions: ScriptVersion[]
  names: string[]
  authors: string[]
  /** Version id → author, for versions that already existed without one. */
  attributed: Map<string, string>
} {
  const mediaDir = dirname(mediaAbs)
  const mediaBase = mediaBasename(basename(mediaAbs))

  // Which existing version, if any, already names each file. Scripts download
  // next to their video, so the scanner's companion grouping usually gets to
  // them first and this is the common case — not the exception. Treating it as
  // "nothing to do" is what left every downloaded script with no author on it.
  const owner = new Map<string, ScriptVersion>()
  for (const version of meta.scriptVersions) {
    for (const file of Object.values(version.files)) {
      if (file) owner.set(resolve(mediaDir, file).toLowerCase(), version)
    }
  }

  const attributed = new Map<string, string>()
  const groups = new Map<string, { files: Record<string, string>; author?: string }>()
  for (const script of scripts) {
    if (!existsSync(script.absPath)) continue
    const existing = owner.get(script.absPath.toLowerCase())
    if (existing) {
      // Already filed. Fill in who wrote it, if nobody has said — never
      // overwrite an author the user set.
      if (script.author && !existing.author) attributed.set(existing.id, script.author)
      continue
    }
    const name = basename(script.absPath)
    const parsed = parseFunscript(mediaBase, name, level)
    const key = parsed?.versionKey ?? name
    const group = groups.get(key) ?? { files: {}, ...(script.author ? { author: script.author } : {}) }
    group.files[parsed?.axis ?? 'main'] = relative(mediaDir, script.absPath).split(PATH_SEP).join('/')
    groups.set(key, group)
  }

  const versions: ScriptVersion[] = []
  const names: string[] = []
  const authors: string[] = [...attributed.values()]
  for (const [key, group] of groups) {
    if (group.files.main === undefined) continue // schema needs a main axis
    // Name the version after its author, or the filename's own
    // variant label when it has one.  The last resort is the script file's own
    // name — 'Default' says nothing when every entry has one.
    const name = key || group.author || scriptVersionName(group.files.main!)
    versions.push({
      id: randomUUID(),
      name,
      ...(group.author ? { author: group.author } : {}),
      files: group.files as ScriptVersion['files']
    })
    names.push(name)
    if (group.author) authors.push(group.author)
  }
  return { versions, names, authors, attributed }
}

/** Stamp the author (and the post it came from) onto versions that lacked one. */
function applyAttribution(
  versions: ScriptVersion[],
  attributed: Map<string, string>,
  sourceUrl?: string
): ScriptVersion[] {
  if (attributed.size === 0) return versions
  return versions.map((v) => {
    const author = attributed.get(v.id)
    if (!author) return v
    return { ...v, author, ...(v.sourceUrl || !sourceUrl ? {} : { sourceUrl }) }
  })
}

/**
 * Post-download ingest: fold the scraped post metadata
 * into the downloaded video's sidecar and attach the downloaded scripts as
 * script versions.
 *
 * Merging is additive and never clobbers the user: an existing title stays,
 * tags are unioned, the post URL is added only if absent. Scripts already
 * picked up by companion grouping (they land next to the video under its
 * basename, so the first ingest often groups them itself) are left alone
 * rather than added twice.
 */
export async function attachPostDownload(
  libraryId: string,
  videoAbsPath: string,
  post: PostMetadata,
  scriptAbsPaths: DownloadedScript[]
): Promise<AttachPostResult | null> {
  const handle = handles.get(libraryId)
  if (!handle) return null
  const relPath = relative(handle.library.rootPath, videoAbsPath).split('\\').join('/')

  // The scripts have to be on disk before grouping can see them, and the
  // watcher debounce means the sidecar shows up a beat after the file does.
  const mediaId = await waitForIngest(handle, relPath, 60_000)
  if (!mediaId) {
    console.error(`[downloads] ${relPath} never got indexed; metadata not applied`)
    return null
  }

  const target = await openForEdit(libraryId, mediaId)
  const { meta } = target

  const grouped = groupDownloadedScripts(meta, target.mediaAbs, scriptAbsPaths)
  const addedVersions = grouped.names
  const scriptVersions = applyAttribution(
    meta.scriptVersions,
    grouped.attributed,
    post.postUrl
  )
  for (const version of grouped.versions) {
    scriptVersions.push({
      ...version,
      ...(post.postUrl ? { sourceUrl: post.postUrl } : {}),
      ...(scriptVersions.length === 0 ? { isDefault: true } : {})
    })
  }

  // Registering the names is what puts them in the filter sidebar and folds a
  // forum's spelling onto the user's own (`Virtual Reality` → `VR`). Skipping
  // it left a downloaded media carrying tags that existed nowhere else.
  const tags = await normaliseNames('tags', [...meta.tags, ...post.tags])
  // Whoever made the scripts, from the post or the reply each one came from.
  // Falls back to the post's author, who is the scripter in the ordinary case.
  const scriptAuthors = await normaliseNames('scriptAuthors', [
    ...meta.scriptAuthors,
    ...grouped.authors,
    ...(grouped.versions.length > 0 && post.author ? [post.author] : [])
  ])
  // Whoever made the video, when the post's title said so. Registered the same
  // way `applyPostMetadata` registers it, so a downloaded media and one the
  // user pointed at the same thread end up with the same names on them.
  const videoAuthors = post.videoAuthor
    ? await normaliseNames('videoAuthors', [...meta.videoAuthors, post.videoAuthor])
    : meta.videoAuthors

  const sources = [...meta.sources]
  const remember = (type: 'eroscripts' | 'original', url: string | undefined): void => {
    if (!url || sources.some((s) => s.url === url)) return
    sources.push({ type, url })
  }
  remember('eroscripts', post.postUrl)
  remember('original', post.downloadUrl)

  await commitSidecar(target, {
    ...meta,
    // An existing title is the user's; only fill a blank one.
    ...(meta.title ? {} : post.title ? { title: post.title } : {}),
    tags,
    scriptAuthors,
    videoAuthors,
    ...(post.otherLinks && post.otherLinks.length > 0
      ? { postLinks: mergePostLinks(meta.postLinks, post.otherLinks) }
      : {}),
    sources,
    scriptVersions,
    updatedAt: new Date().toISOString()
  })

  const twin = handle.db.findFingerprintTwin(
    meta.fileFingerprint.blake3Head,
    meta.fileFingerprint.size,
    mediaId
  )
  return { mediaId, addedVersions, duplicateOf: twin?.filePath ?? null }
}

/**
 * Paged media list. With a libraryId: that library only (throws
 * library_not_found if not started). Without: aggregate over every started
 * library — each is asked for the first offset+limit rows, then the pages
 * are merge-sorted and sliced, so the result matches what one big index
 * would return. Registered-but-unstarted libraries are simply absent.
 */
/**
 * Most a single "play everything here" will queue. Past this the list stops
 * being something a person is choosing to watch, and every edit to it would
 * write megabytes to disk.
 */
const VIEW_QUEUE_MAX = 5000

export function listMedia(opts: {
  libraryId?: string
  offset: number
  limit: number
  search?: string
  filter?: FilterNode | null
  sort?: MediaSort
  /** Which playlist `sort: 'playlist'` means. */
  playlistOrder?: string
  /** Only these rows, whatever else matches. */
  ids?: string[]
}): MediaListPage {
  const { libraryId, offset, limit, ...query } = opts
  if (libraryId) {
    return requireHandle(libraryId).db.listMedia(libraryId, { offset, limit, ...query })
  }
  // A playlist reaches across libraries, so the merge below has to be able to
  // compare rows from different indexes — which it can only do if each one
  // brought its rank with it. See mergeComparator.

  let total = 0
  const merged: MediaListPage['items'] = []
  for (const handle of handles.values()) {
    const page = handle.db.listMedia(handle.library.id, {
      offset: 0,
      limit: offset + limit,
      ...query
    })
    total += page.total
    merged.push(...page.items)
  }
  merged.sort(mergeComparator(opts.sort))
  return { items: merged.slice(offset, offset + limit), total }
}

/**
 * The rows behind a list of targets, in one query per library.
 *
 * The queue is a list of ids and has to show titles, durations and paths for
 * all of them at once. Asking for each media on its own was a round trip and a
 * sidecar read per row; this is the index answering the question it is for.
 * The order returned is the index's, not the caller's — a queue knows its own
 * order and matches the rows to it by id.
 */
export function mediaByIds(targets: { libraryId: string; mediaId: string }[]): MediaListItem[] {
  const byLibrary = new Map<string, string[]>()
  for (const target of targets) {
    const list = byLibrary.get(target.libraryId)
    if (list) list.push(target.mediaId)
    else byLibrary.set(target.libraryId, [target.mediaId])
  }
  const out: MediaListItem[] = []
  for (const [libraryId, ids] of byLibrary) {
    const handle = handles.get(libraryId)
    // A library that is not started has no index to ask; its rows are simply
    // absent, exactly as they are from the grid.
    if (!handle) continue
    // Chunked: SQLite has a ceiling on bound parameters, and a queue can be
    // longer than it.
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const chunk = ids.slice(i, i + ID_CHUNK)
      out.push(...handle.db.listMedia(libraryId, { offset: 0, limit: chunk.length, ids: chunk }).items)
    }
  }
  return out
}

/** How many ids one query may name; SQLite's parameter ceiling is 999. */
const ID_CHUNK = 400

/**
 * Merging pages from several libraries has to repeat the sort each of them
 * already did — SQL cannot order across databases. Same keys, same direction,
 * and the path always breaks ties so paging stays stable.
 */
function mergeComparator(sort: MediaSort | undefined) {
  const byPath = (a: MediaListPage['items'][number], b: MediaListPage['items'][number]): number =>
    a.filePath.localeCompare(b.filePath) || a.id.localeCompare(b.id)
  const desc = (a: number | null, b: number | null): number => (b ?? -1) - (a ?? -1)
  const text = (a: string | null, b: string | null): number => (a ?? '').localeCompare(b ?? '')

  return (a: MediaListPage['items'][number], b: MediaListPage['items'][number]): number => {
    switch (sort) {
      case 'playlist': {
        // A rank is a plain string by design, so the merge compares them the
        // same way SQLite did. No rank means never given a place, and those go
        // after everything that has one rather than sorting as an empty string,
        // which would put them first.
        const ra = a.playlistRank
        const rb = b.playlistRank
        if (ra === null && rb === null) return byPath(a, b)
        if (ra === null) return 1
        if (rb === null) return -1
        return ra < rb ? -1 : ra > rb ? 1 : byPath(a, b)
      }
      case 'title':
        return text(a.title || a.filePath, b.title || b.filePath) || byPath(a, b)
      // Missing before: sorting several libraries by "recently added" quietly
      // fell through to path order, because the row carried no such time.
      case 'addedAt':
        return desc(a.addedAt, b.addedAt) || byPath(a, b)
      case 'updatedAt':
        return desc(a.modifiedAt, b.modifiedAt) || byPath(a, b)
      case 'size':
        return desc(a.fileSize, b.fileSize) || byPath(a, b)
      case 'rating':
        return desc(a.rating, b.rating) || byPath(a, b)
      case 'scriptCount':
        return desc(a.scriptVersionCount, b.scriptVersionCount) || byPath(a, b)
      default:
        return byPath(a, b)
    }
  }
}

/** Every media a filter matches, across libraries, for a select-all. */
export function matchingTargets(opts: {
  libraryId?: string
  search?: string
  filter?: FilterNode | null
}): { libraryId: string; mediaId: string }[] {
  const targets: { libraryId: string; mediaId: string }[] = []
  for (const handle of handles.values()) {
    if (opts.libraryId && handle.library.id !== opts.libraryId) continue
    for (const mediaId of handle.db.matchingIds(handle.library.id, opts)) {
      targets.push({ libraryId: handle.library.id, mediaId })
    }
  }
  return targets
}

/**
 * The view as a queue: everything it matches, in the order it shows them.
 *
 * Built on `listMedia` rather than on `matchingTargets`, which returns ids in
 * no particular order and one library at a time — for a queue the order *is*
 * the point, and it has to be the order on screen, merge across libraries and
 * all. Only the ids travel back.
 */
export function viewTargets(opts: {
  libraryId?: string
  search?: string
  filter?: FilterNode | null
  sort?: MediaSort
  playlistOrder?: string
}): { targets: { libraryId: string; mediaId: string }[]; capped: boolean } {
  const page = listMedia({ ...opts, offset: 0, limit: VIEW_QUEUE_MAX })
  return {
    targets: page.items.map((item) => ({ libraryId: item.libraryId, mediaId: item.id })),
    capped: page.total > page.items.length
  }
}

/** Name → media count, summed over every started library. */
export function nameCounts(): Record<NameField, Record<string, number>> {
  const merged = {} as Record<NameField, Record<string, number>>
  for (const handle of handles.values()) {
    for (const [field, counts] of Object.entries(handle.db.nameCounts())) {
      const bucket = (merged[field as NameField] ??= {})
      for (const [name, n] of Object.entries(counts)) bucket[name] = (bucket[name] ?? 0) + n
    }
  }
  return merged
}

/* ------------------------------------------------------------------ *
 * Media whose file has not arrived yet (bought elsewhere, to be supplied)
 * ------------------------------------------------------------------ */

/** Characters Windows will not take in a file name. */
function safeFileName(name: string): string {
  return (
    name
      .replace(/[\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'untitled'
  )
}

/**
 * A name not already taken in the folder; never overwrite what is there.
 *
 * `ownSidecar` is the caller's own placeholder sidecar, which is expected to be
 * sitting on the name being asked for — without it, filling in a placeholder
 * collides with itself and the file lands as "… (2)".
 */
function freeName(dir: string, base: string, ext: string, ownSidecar?: string): string {
  const taken = (name: string): boolean => {
    const abs = join(dir, name)
    if (existsSync(abs)) return true
    const sidecar = sidecarPathFor(abs)
    if (ownSidecar && sidecar.toLowerCase() === ownSidecar.toLowerCase()) return false
    return existsSync(sidecar)
  }
  let candidate = `${base}${ext}`
  for (let n = 2; taken(candidate); n++) candidate = `${base} (${n})${ext}`
  return candidate
}

/**
 * Record a post whose file has to be bought or fetched by hand: a sidecar with
 * everything except the video, so the metadata is already in place when the
 * file finally shows up.
 *
 * The placeholder is a normal library entry with no file behind it. That is
 * not a special case in the index — a sidecar without its media is already
 * "missing" — it only needs the `wanted` block to say the file never arrived
 * rather than went away, because those two need different offers on screen.
 */
export async function addWantedMedia(
  libraryId: string,
  post: {
    title: string
    tags: string[]
    postUrl: string
    author?: string
    /** Whoever made the video, when the post's title named them. */
    videoAuthor?: string
    sources: { url: string; hoster: string; label: string }[]
    otherLinks?: { url: string; hoster: string; label: string }[]
  }
): Promise<{ mediaId: string; filePath: string } | null> {
  const handle = handles.get(libraryId)
  if (!handle) return null

  const root = handle.library.rootPath
  // `.mp4` is a placeholder extension: whatever the user supplies later wins,
  // and the sidecar is renamed to match it.
  const fileName = freeName(root, safeFileName(post.title), '.mp4')
  const mediaAbs = join(root, fileName)
  const now = new Date().toISOString()

  const meta: MediaMeta = {
    schemaVersion: MEDIA_META_VERSION,
    id: randomUUID(),
    // No file, so no fingerprint. Zero is honest here; it is replaced the
    // moment a real file is attached.
    fileFingerprint: { size: 0, blake3Head: '' },
    wanted: { sources: post.sources, dismissed: [], addedAt: now },
    ...(post.title ? { title: post.title } : {}),
    // Same registration the edit paths do, so a downloaded post's tags reach
    // the filter sidebar instead of existing only on the media.
    tags: await normaliseNames('tags', post.tags),
    videoAuthors: post.videoAuthor
      ? await normaliseNames('videoAuthors', [post.videoAuthor])
      : [],
    scriptAuthors: post.author ? await normaliseNames('scriptAuthors', [post.author]) : [],
    studios: [],
    playlists: [],
    playlistRanks: {},
    sources: post.postUrl ? [{ type: 'eroscripts' as const, url: post.postUrl }] : [],
    postLinks: post.otherLinks ?? [],
    scriptVersions: [],
    subtitles: [],
    userMeta: {},
    createdAt: now,
    updatedAt: now
  }

  const sidecarAbs = sidecarPathFor(mediaAbs)
  await writeSidecar(sidecarAbs, meta)
  const mtime = Math.floor((await stat(sidecarAbs)).mtimeMs)
  handle.db.upsertFromSidecar(meta, fileName, mtime)
  libraryEvents.emit('media-changed', { libraryId })
  return { mediaId: meta.id, filePath: fileName }
}

/**
 * Supply the file a placeholder was waiting for, from a file the user pointed
 * at.
 *
 * Copy, not move: the user may have paid for that download and it may live on
 * a drive we are not entitled to empty.
 */
export async function attachWantedFile(
  libraryId: string,
  mediaId: string,
  sourceAbsPath: string
): Promise<MediaDetail | null> {
  if (!handles.has(libraryId)) return null
  if (!existsSync(sourceAbsPath)) throw new AppError('media_not_found', { path: sourceAbsPath })

  const target = await openForEdit(libraryId, mediaId)
  if (!target.meta.wanted) throw new AppError('media_not_found', { mediaId })

  const placed = await fillWanted(target, extensionOf(sourceAbsPath), (finalAbs) =>
    copyFile(sourceAbsPath, finalAbs)
  )
  return placed.detail
}

/**
 * Supply the file a placeholder was waiting for, from a download that was
 * queued for that entry. Moved rather than copied: the partial file is the
 * queue's own, and nobody else will ever look for it.
 *
 * The file goes straight to the placeholder's name instead of landing in the
 * library root first. Landing first would let the scanner see an unknown video
 * and stand up a second entry for it before this one was filled — which is
 * exactly how a pasted link used to end up as an entry of its own.
 *
 * Returns where the file ended up, or null when the entry is gone or already
 * has its file; the caller then files the download like any other.
 */
export async function fillWantedFromDownload(
  libraryId: string,
  mediaId: string,
  partPath: string,
  fileName: string
): Promise<string | null> {
  if (!handles.has(libraryId)) return null
  const target = await openForEdit(libraryId, mediaId).catch(() => null)
  if (!target?.meta.wanted) return null
  const placed = await fillWanted(target, extensionOf(fileName), (finalAbs) =>
    moveFile(partPath, finalAbs)
  )
  return placed.finalAbs
}

/** `.mp4` from `clip.mp4`; empty when the name has none. */
function extensionOf(path: string): string {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot) : ''
}

/** Rename, or copy and delete when the two paths are on different volumes. */
async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    await copyFile(from, to)
    await rm(from, { force: true })
  }
}

/**
 * Put a file in place beside a placeholder's sidecar under the placeholder's
 * own name, so the scripts already grouped against that name keep matching,
 * and turn the placeholder into an ordinary entry.
 */
async function fillWanted(
  target: EditTarget,
  ext: string,
  put: (finalAbs: string) => Promise<void>
): Promise<{ detail: MediaDetail; finalAbs: string }> {
  const { handle, meta } = target
  const libraryId = handle.library.id
  const dir = dirname(target.mediaAbs)
  const base = mediaBasename(basename(target.mediaAbs))
  const finalName = freeName(dir, base, ext || '.mp4', sidecarPathFor(target.mediaAbs))
  const finalAbs = join(dir, finalName)

  await put(finalAbs)

  // The sidecar is named after its media file, so it moves with the extension.
  const oldSidecar = sidecarPathFor(target.mediaAbs)
  const size = (await stat(finalAbs)).size
  const { wanted: _wanted, ...rest } = meta
  const filled: MediaMeta = {
    ...rest,
    // The scanner fingerprints it properly on the next pass; the size alone is
    // enough for it to notice this row changed.
    fileFingerprint: { size, blake3Head: '' },
    updatedAt: new Date().toISOString()
  }
  await writeSidecar(sidecarPathFor(finalAbs), filled)
  if (oldSidecar !== sidecarPathFor(finalAbs)) await rm(oldSidecar, { force: true })

  const relPath = relative(handle.library.rootPath, finalAbs).split('\\').join('/')
  const mtime = Math.floor((await stat(sidecarPathFor(finalAbs))).mtimeMs)
  handle.db.upsertFromSidecar(filled, relPath, mtime)
  libraryEvents.emit('media-changed', { libraryId })
  return {
    detail: toDetail(libraryId, relPath, finalAbs, filled, handle.db.fileAddedAt(filled.id)),
    finalAbs
  }
}

/**
 * Group already-downloaded scripts onto an existing media entry, the way the
 * scanner would: `clip.funscript` + `clip.roll.funscript` become one
 * multi-axis version named after the post's author.
 *
 * Used for a placeholder whose video has not arrived — the scripts are real
 * and belong to it now, not once the file shows up.
 */
export async function attachScriptsToMedia(
  libraryId: string,
  mediaId: string,
  scripts: DownloadedScript[],
  from: { author?: string; postUrl?: string }
): Promise<string[]> {
  const target = await openForEdit(libraryId, mediaId)
  const { meta } = target

  const grouped = groupDownloadedScripts(meta, target.mediaAbs, scripts)
  if (grouped.names.length === 0 && grouped.attributed.size === 0) return []

  const scriptVersions = applyAttribution(meta.scriptVersions, grouped.attributed, from.postUrl)
  for (const version of grouped.versions) {
    scriptVersions.push({
      ...version,
      // A version with no author of its own belongs to whoever posted.
      ...(version.author || !from.author ? {} : { author: from.author }),
      ...(from.postUrl ? { sourceUrl: from.postUrl } : {}),
      ...(scriptVersions.length === 0 ? { isDefault: true } : {})
    })
  }

  const scriptAuthors = await normaliseNames('scriptAuthors', [
    ...meta.scriptAuthors,
    ...grouped.authors,
    ...(from.author ? [from.author] : [])
  ])

  await commitSidecar(target, {
    ...meta,
    scriptAuthors,
    scriptVersions,
    updatedAt: new Date().toISOString()
  })
  return grouped.names
}

/**
 * "Is this the file that entry was waiting for?"
 *
 * A scene bought elsewhere arrives named after the script that came with the
 * post — `VRPRD-016_B.mp4` beside `VRPRD-016_B.funscript` — so the placeholder's
 * own scripts are the strongest thing to match on. The placeholder's own name
 * is tried too, since it is the post title and some people rename to that.
 *
 * The app only ever asks. Merging two entries on a name alone would be the kind
 * of guess that is silently wrong months later.
 */
function wantedBaseNames(meta: MediaMeta, mediaAbs: string): string[] {
  const bases = new Set<string>([mediaBasename(basename(mediaAbs))])
  for (const version of meta.scriptVersions) {
    for (const file of Object.values(version.files)) {
      if (!file) continue
      const name = basename(file)
      const withoutExt = name.slice(0, name.toLowerCase().lastIndexOf(FUNSCRIPT_EXTENSION))
      if (!withoutExt) continue
      // `clip.roll.funscript` belongs to `clip`, not to `clip.roll`.
      const axis = SCRIPT_AXIS_KEYS.find((a) => withoutExt.toLowerCase().endsWith(`.${a}`))
      bases.add(axis ? withoutExt.slice(0, -(axis.length + 1)) : withoutExt)
    }
  }
  return [...bases].filter(Boolean)
}

/** Media in the library that might be the missing file, minus the ones ruled out. */
export async function findWantedMatches(
  libraryId: string,
  mediaId: string
): Promise<{ mediaId: string; filePath: string; fileName: string }[]> {
  const handle = handles.get(libraryId)
  if (!handle) return []
  const target = await openForEdit(libraryId, mediaId).catch(() => null)
  if (!target?.meta.wanted) return []

  const dismissed = new Set(target.meta.wanted.dismissed)
  return handle.db
    .findByBaseNames(wantedBaseNames(target.meta, target.mediaAbs), mediaId)
    .filter((m) => !dismissed.has(m.id))
    .map((m) => ({
      mediaId: m.id,
      filePath: m.filePath,
      fileName: m.filePath.split('/').pop() ?? m.filePath
    }))
}

/** Remember that this candidate is not the file, so it stops being offered. */
export async function dismissWantedMatch(
  libraryId: string,
  mediaId: string,
  candidateId: string
): Promise<void> {
  const target = await openForEdit(libraryId, mediaId)
  const { meta } = target
  if (!meta.wanted) return
  if (meta.wanted.dismissed.includes(candidateId)) return
  await commitSidecar(target, {
    ...meta,
    wanted: { ...meta.wanted, dismissed: [...meta.wanted.dismissed, candidateId] },
    updatedAt: new Date().toISOString()
  })
}

/**
 * Fold placeholder entries into one surviving entry and drop them.
 *
 * The same scene reaches the library more than once — two scripters posting for
 * one video, or a post whose video was bought elsewhere. What survives is the
 * entry that has the file, or (when they are all still waiting for one) the
 * entry the user picked.
 *
 * Files are left exactly where they are. Sidecar script paths are relative and
 * may point outside the media's own folder, so a version keeps working from
 * wherever it was downloaded; moving a user's files to tidy up bookkeeping is
 * not something that should happen behind one click. What moves is what the
 * posts carried: title, names, sources and the script versions themselves.
 */
export async function mergeWantedInto(
  libraryId: string,
  targetId: string,
  sourceIds: string[]
): Promise<MediaDetail | null> {
  const handle = handles.get(libraryId)
  if (!handle) return null
  const target = await openForEdit(libraryId, targetId)
  const sources = await Promise.all(
    sourceIds
      .filter((id) => id !== targetId)
      .map(async (id) => {
        const source = await openForEdit(libraryId, id)
        // Only an entry with no file of its own can be folded away: merging two
        // real files would silently orphan one of them.
        if (!source.meta.wanted) throw new AppError('media_not_found', { mediaId: id })
        return { id, ...source }
      })
  )
  if (sources.length === 0) {
    return toDetail(
      libraryId,
      target.relPath,
      target.mediaAbs,
      target.meta,
      target.handle.db.fileAddedAt(target.meta.id)
    )
  }

  const targetDir = dirname(target.mediaAbs)
  const held = new Set(
    target.meta.scriptVersions.flatMap((v) =>
      Object.values(v.files)
        .filter((f): f is string => Boolean(f))
        .map((f) => resolve(targetDir, f).toLowerCase())
    )
  )

  const moved: ScriptVersion[] = []
  const subtitles = [...target.meta.subtitles]
  const heldSubtitles = new Set(
    target.meta.subtitles.map((s) => resolve(targetDir, s.path).toLowerCase())
  )

  for (const source of sources) {
    const sourceDir = dirname(source.mediaAbs)
    for (const version of source.meta.scriptVersions) {
      const files: Record<string, string> = {}
      for (const [axis, file] of Object.entries(version.files)) {
        if (!file) continue
        const abs = resolve(sourceDir, file)
        // Two posts can ship the identical script; it is one file either way.
        if (held.has(abs.toLowerCase())) continue
        held.add(abs.toLowerCase())
        files[axis] = relative(targetDir, abs).split(PATH_SEP).join('/')
      }
      if (files.main === undefined) continue
      moved.push({ ...version, id: randomUUID(), files: files as ScriptVersion['files'] })
    }
    for (const subtitle of source.meta.subtitles) {
      const abs = resolve(sourceDir, subtitle.path)
      if (heldSubtitles.has(abs.toLowerCase())) continue
      heldSubtitles.add(abs.toLowerCase())
      subtitles.push({ ...subtitle, path: relative(targetDir, abs).split(PATH_SEP).join('/') })
    }
  }

  const names = {} as Record<NameField, string[]>
  for (const field of NAME_FIELDS) {
    names[field] = await normaliseNames(field, [
      ...target.meta[field],
      ...sources.flatMap((s) => s.meta[field])
    ])
  }

  const sourceLinks = [...target.meta.sources]
  for (const source of sources) {
    for (const entry of source.meta.sources) {
      if (!sourceLinks.some((s) => s.url === entry.url)) sourceLinks.push(entry)
    }
  }

  const postLinks = [...target.meta.postLinks]
  for (const source of sources) {
    for (const link of source.meta.postLinks) {
      if (!postLinks.some((l) => l.url === link.url)) postLinks.push(link)
    }
  }

  // The survivor may itself still be waiting for a file, in which case it
  // inherits everywhere the merged entries said it could be bought.
  const wanted = target.meta.wanted
    ? {
        ...target.meta.wanted,
        sources: [...target.meta.wanted.sources],
        dismissed: [...new Set(sources.flatMap((s) => s.meta.wanted?.dismissed ?? []).concat(target.meta.wanted.dismissed))]
      }
    : undefined
  if (wanted) {
    for (const source of sources) {
      for (const entry of source.meta.wanted?.sources ?? []) {
        if (!wanted.sources.some((s) => s.url === entry.url)) wanted.sources.push(entry)
      }
    }
  }

  /**
   * A placeholder the scanner made from loose scripts has no title of its own —
   * it is filled in from the file name so the row has something to show. Moving
   * that onto a real video renames the scene after a script file, so only a
   * title that says more than the placeholder's own name travels: one the post
   * carried, or one the user typed.
   */
  const carriedTitle = sources.find((s) => {
    const own = s.meta.title
    if (!own) return false
    if (s.meta.sources.length > 0 || s.meta.postLinks.length > 0) return true
    return own !== mediaBasename(basename(s.mediaAbs))
  })?.meta.title
  const title = target.meta.title || carriedTitle

  const detail = await commitSidecar(target, {
    ...target.meta,
    // An existing title is the user's; only fill a blank one.
    ...(title ? { title } : {}),
    ...names,
    ...(wanted ? { wanted } : {}),
    sources: sourceLinks,
    postLinks,
    subtitles,
    scriptVersions: combineAxes([...target.meta.scriptVersions, ...moved]),
    updatedAt: new Date().toISOString()
  })

  // The placeholders have served their purpose; leaving them would show the
  // library the same scene several times over.
  for (const source of sources) {
    await rm(sidecarPathFor(source.mediaAbs), { force: true })
    handle.db.remove(source.id)
  }
  libraryEvents.emit('media-changed', { libraryId })
  return detail
}

/** The candidate IS the file: fold this one placeholder into it. */
export async function linkWantedTo(
  libraryId: string,
  mediaId: string,
  candidateId: string
): Promise<MediaDetail | null> {
  return mergeWantedInto(libraryId, candidateId, [mediaId])
}
