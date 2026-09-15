import { existsSync } from 'node:fs'
import { rename, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { shell } from 'electron'
import { AppError } from '@shared/errors'
import type { MediaDetail } from '@shared/schemas/media-index'
import type { MediaMeta, ScriptVersion } from '@shared/schemas/media-meta'
import { fingerprintKey, type IgnoredEntry } from '@shared/schemas/library-state'
import type {
  DeleteMode,
  DeletePlan,
  FileKind,
  RenamePlan
} from '@shared/schemas/media-lifecycle'
import { companionRefs } from '../db/index-db'
import { foldersOf, isUnder, type LibraryFolder } from './library-folders'
import { mediaBasename } from './companion-grouping'
import { readSidecar, sidecarPathFor, writeSidecar } from './sidecar'
import {
  getMediaDetail,
  internalHandle,
  listStartedLibraries,
  notifyMediaChanged,
  requestSync,
  runningHandle,
  type InternalLibraryHandle
} from './library-manager'

/**
 * Deleting and renaming media — the two operations that touch the user's own
 * files rather than the app's metadata.
 *
 * Both are built on one question the index can now answer: *who else names this
 * file?* A script is routinely shared between entries (a version added by
 * reference rather than copied), and neither operation may act on a file
 * without knowing that.
 */

type SharedFile = DeletePlan['shared'][number]

interface ResolvedEntry {
  mediaId: string
  relPath: string
  mediaAbs: string
  meta: MediaMeta
  /** Companion files, library-relative. */
  companions: { kind: 'script' | 'subtitle'; path: string }[]
}

async function resolveEntries(
  handle: InternalLibraryHandle,
  mediaIds: string[]
): Promise<ResolvedEntry[]> {
  const out: ResolvedEntry[] = []
  for (const mediaId of mediaIds) {
    const relPath = handle.db.getMediaRelPath(mediaId)
    if (!relPath) continue
    const mediaAbs = join(handle.library.rootPath, relPath)
    const sidecar = await readSidecar(sidecarPathFor(mediaAbs))
    if (!sidecar.ok) continue
    out.push({
      mediaId,
      relPath,
      mediaAbs,
      meta: sidecar.meta,
      companions: companionRefs(sidecar.meta, relPath)
    })
  }
  return out
}

/**
 * What a delete would actually do, so the confirmation can say it rather than
 * ask the user to trust a verb. Nothing here writes.
 */
export async function planDelete(
  libraryId: string,
  mediaIds: string[],
  mode: DeleteMode
): Promise<DeletePlan> {
  const handle = internalHandle(libraryId)
  const entries = await resolveEntries(handle, mediaIds)
  const selectedIds = entries.map((e) => e.mediaId)

  const companionPaths = [...new Set(entries.flatMap((e) => e.companions.map((c) => c.path)))]
  const users = handle.db.othersUsing(companionPaths, selectedIds)

  const sharedByPath = new Map<string, SharedFile>()
  for (const user of users) {
    const key = user.path.toLowerCase()
    const existing = sharedByPath.get(key)
    const who = { mediaId: user.mediaId, title: user.title, mediaPath: user.mediaPath }
    if (existing) existing.usedBy.push(who)
    else sharedByPath.set(key, { path: user.path, usedBy: [who] })
  }
  const sharedKeys = new Set(sharedByPath.keys())

  const files: { path: string; kind: FileKind }[] = []
  if (mode === 'files') {
    for (const entry of entries) {
      if (!entry.meta.wanted && existsSync(entry.mediaAbs)) {
        files.push({ path: entry.relPath, kind: 'media' })
      }
      for (const companion of entry.companions) {
        if (sharedKeys.has(companion.path.toLowerCase())) continue
        if (!existsSync(join(handle.library.rootPath, companion.path))) continue
        files.push({ path: companion.path, kind: companion.kind })
      }
      files.push({ path: `${entry.relPath}.meta.json`, kind: 'sidecar' })
    }
  }

  return {
    entries: entries.map((e) => ({
      mediaId: e.mediaId,
      title: e.meta.title ?? null,
      fileName: e.relPath.split('/').pop() ?? e.relPath,
      wanted: e.meta.wanted !== undefined,
      fileMissing: !existsSync(e.mediaAbs)
    })),
    files,
    shared: [...sharedByPath.values()],
    companions: [...new Set(entries.flatMap((e) => e.companions.map((c) => c.path)))],
    // A placeholder is already the "scripts with no video" shape; offering to
    // turn it into one would be offering to do nothing.
    canKeepScripts: entries.some(
      (e) => e.meta.wanted === undefined && e.companions.some((c) => c.kind === 'script')
    )
  }
}

export interface DeleteResult {
  removed: number
  /** Library-relative paths that reached the Recycle Bin. */
  trashed: string[]
  /** Paths that could not be moved (locked, permissions); the entry still goes. */
  failed: string[]
  /** Files left alone because another entry names them. */
  skippedShared: string[]
}

export interface DeleteOptions {
  mode: DeleteMode
  /**
   * 'library' mode only: leave the scripts visible as a placeholder entry
   * instead of taking them out of the library with their video. Ignored for
   * entries that are already placeholders.
   */
  keepScripts: boolean
}

/**
 * Remove entries from the library, with or without their files.
 *
 * The sidecar is kept in 'library' mode. It is what the user typed — title,
 * tags, rating — and the ignore list is what makes it invisible, so putting the
 * entry back later restores it whole rather than re-ingesting a blank one.
 */
export async function deleteMedia(
  libraryId: string,
  mediaIds: string[],
  options: DeleteOptions
): Promise<DeleteResult> {
  const handle = internalHandle(libraryId)
  const root = handle.library.rootPath
  const entries = await resolveEntries(handle, mediaIds)
  if (entries.length === 0) throw new AppError('media_not_found')

  const selectedIds = entries.map((e) => e.mediaId)
  const companionPaths = [...new Set(entries.flatMap((e) => e.companions.map((c) => c.path)))]
  const shared = new Set(
    handle.db.othersUsing(companionPaths, selectedIds).map((u) => u.path.toLowerCase())
  )

  const result: DeleteResult = { removed: 0, trashed: [], failed: [], skippedShared: [] }

  const trash = async (relPath: string): Promise<void> => {
    const abs = join(root, relPath)
    if (!existsSync(abs)) return
    try {
      await shell.trashItem(abs)
      result.trashed.push(relPath)
    } catch (e) {
      console.error(`[library] trash failed for ${abs}:`, e)
      result.failed.push(relPath)
    }
  }

  // Collected, then written in one go: a folder of a hundred entries used to
  // rewrite the whole ignore list a hundred times over.
  const toIgnore: IgnoredEntry[] = []

  for (const entry of entries) {
    if (options.mode === 'files') {
      for (const companion of entry.companions) {
        if (shared.has(companion.path.toLowerCase())) {
          result.skippedShared.push(companion.path)
          continue
        }
        await trash(companion.path)
      }
      await trash(entry.relPath)
      await trash(`${entry.relPath}.meta.json`)
    } else {
      // A placeholder's scripts have nowhere else to go: keeping them out of
      // the ignore list would rebuild the very entry just removed.
      const isPlaceholder = entry.meta.wanted !== undefined
      const keep = options.keepScripts && !isPlaceholder
      toIgnore.push({
        id: entry.mediaId,
        fingerprint: fingerprintKey(
          entry.meta.fileFingerprint.size,
          entry.meta.fileFingerprint.blake3Head
        ),
        path: entry.relPath,
        title: entry.meta.title ?? null,
        companions: keep ? [] : entry.companions.map((c) => c.path),
        removedAt: new Date().toISOString()
      })
    }
  }

  // Before the index rows go: if the list cannot be written, the entries are
  // still in the library rather than gone from it with nothing recording why.
  await handle.ignored.addMany(toIgnore)

  for (const entry of entries) {
    handle.db.remove(entry.mediaId)
    result.removed += 1
  }

  notifyMediaChanged(libraryId)
  return result
}

/** Put a removed entry back: the next scan indexes it from scratch. */
export async function restoreIgnored(libraryId: string, id: string): Promise<boolean> {
  const handle = internalHandle(libraryId)
  const removed = await handle.ignored.remove(id)
  // The scan is kicked off here rather than left to the watcher: nothing on
  // disk changed, so no watcher event is coming, and an "undo" that visibly
  // undoes nothing reads as a broken button.
  if (removed) await requestSync(libraryId)
  return removed
}

export async function clearIgnored(libraryId: string): Promise<void> {
  const handle = internalHandle(libraryId)
  await handle.ignored.clear()
  await requestSync(libraryId)
}

/**
 * Empty while the library is still starting: the page asks for this the moment
 * it mounts, and at boot the libraries come up one after another. Nothing is
 * lost by answering "none yet" — the sync emits `media-changed` when it lands,
 * and the page asks again.
 */
export function listIgnored(libraryId: string): ReturnType<InternalLibraryHandle['ignored']['list']> {
  return runningHandle(libraryId)?.ignored.list() ?? []
}

/* ------------------------------------------------------- removing a folder */

/**
 * The folder tree, for one library or for every one that is running.
 *
 * Two callers with the same question: the settings page, which removes a folder
 * from one library, and the filter sidebar, which browses all of them at once.
 * Each row says which library it belongs to — a path on its own is ambiguous
 * the moment two libraries are open.
 *
 * Empty while a library is still starting, as `listIgnored` is.
 */
export function libraryFolders(libraryId?: string): (LibraryFolder & { libraryId: string })[] {
  const libraries = libraryId
    ? [libraryId]
    : listStartedLibraries().map((started) => started.libraryId)
  const out: (LibraryFolder & { libraryId: string })[] = []
  for (const id of libraries) {
    const handle = runningHandle(id)
    if (!handle) continue
    const paths = handle.db.listIndexed().map((row) => row.filePath)
    out.push(...foldersOf(paths).map((folder) => ({ ...folder, libraryId: id })))
  }
  return out
}

function idsUnder(handle: InternalLibraryHandle, folder: string): string[] {
  return handle.db
    .listIndexed()
    .filter((row) => isUnder(folder, row.filePath))
    .map((row) => row.id)
}

/**
 * Take a whole folder out of the library, files left where they are.
 *
 * Same door as removing entries one at a time — each one lands in the ignore
 * list and can be put back from there — so a folder of a hundred scripts is one
 * click to remove and one click to undo, rather than a hundred of each.
 */
export async function removeFolder(libraryId: string, folder: string): Promise<DeleteResult> {
  const handle = internalHandle(libraryId)
  const ids = idsUnder(handle, folder)
  if (ids.length === 0) return { removed: 0, trashed: [], failed: [], skippedShared: [] }
  return deleteMedia(libraryId, ids, { mode: 'library', keepScripts: false })
}

/* ------------------------------------------------------------------ rename */

/** Characters Windows will not accept in a file name, plus path separators. */
const INVALID_NAME = /[<>:"/\\|?*\u0000-\u001f]/

/**
 * One file in a rename. `skipped` says why a file keeps its name: a companion
 * outside the media's folder, one another entry shares, or one whose name never
 * followed the media's to begin with. The sidecar goes on pointing at it either
 * way — nothing is lost by leaving it alone.
 */
type RenamePlanItem = RenamePlan['items'][number]

/**
 * `movie` → `holiday` turns `movie_authorA.roll.funscript` into
 * `holiday_authorA.roll.funscript`: only the part that was the media's name
 * changes, so author labels and axis suffixes survive untouched.
 * Returns null when the name never started with the media's, which is the
 * signal to leave that file alone.
 */
function renamedCompanion(oldBase: string, newBase: string, fileName: string): string | null {
  if (fileName.length < oldBase.length) return null
  if (fileName.slice(0, oldBase.length).toLowerCase() !== oldBase.toLowerCase()) return null
  return newBase + fileName.slice(oldBase.length)
}

interface RenameContext {
  handle: InternalLibraryHandle
  relPath: string
  mediaAbs: string
  meta: MediaMeta
  mediaDir: string
  oldName: string
  oldBase: string
  newBase: string
}

async function openForRename(
  libraryId: string,
  mediaId: string,
  newName: string
): Promise<RenameContext> {
  const trimmed = newName.trim()
  if (trimmed === '' || trimmed === '.' || trimmed === '..' || INVALID_NAME.test(trimmed)) {
    throw new AppError('invalid_file_name')
  }
  const handle = internalHandle(libraryId)
  const relPath = handle.db.getMediaRelPath(mediaId)
  if (!relPath) throw new AppError('media_not_found')
  const mediaAbs = join(handle.library.rootPath, relPath)
  const sidecar = await readSidecar(sidecarPathFor(mediaAbs))
  if (!sidecar.ok) throw new AppError('media_not_found')
  return {
    handle,
    relPath,
    mediaAbs,
    meta: sidecar.meta,
    mediaDir: dirname(mediaAbs),
    oldName: basename(mediaAbs),
    oldBase: mediaBasename(basename(mediaAbs)),
    newBase: mediaBasename(trimmed)
  }
}

/** Which files a rename would touch, and which it would leave alone. */
export async function planRename(
  libraryId: string,
  mediaId: string,
  newName: string,
  renameCompanions: boolean
): Promise<RenamePlan> {
  return buildRenamePlan(await openForRename(libraryId, mediaId, newName), newName, renameCompanions)
}

function buildRenamePlan(
  ctx: RenameContext,
  newName: string,
  renameCompanions: boolean
): RenamePlan {
  const mediaId = ctx.meta.id
  const trimmed = newName.trim()
  const items: RenamePlanItem[] = [{ from: ctx.oldName, to: trimmed, kind: 'media' }]
  const collides: string[] = []

  const newAbs = join(ctx.mediaDir, trimmed)
  if (newAbs.toLowerCase() !== ctx.mediaAbs.toLowerCase() && existsSync(newAbs)) {
    collides.push(trimmed)
  }
  items.push({
    from: `${ctx.oldName}.meta.json`,
    to: `${trimmed}.meta.json`,
    kind: 'sidecar'
  })

  if (renameCompanions) {
    const refs = companionRefs(ctx.meta, ctx.relPath)
    const shared = new Set(
      ctx.handle.db.othersUsing(refs.map((r) => r.path), [mediaId]).map((u) => u.path.toLowerCase())
    )
    for (const companion of companionFiles(ctx.meta)) {
      const item = planCompanion(ctx, companion, shared)
      items.push(item)
      if (
        item.skipped === undefined &&
        existsSync(join(ctx.mediaDir, item.to)) &&
        item.to.toLowerCase() !== item.from.toLowerCase()
      ) {
        collides.push(item.to)
      }
    }
  }

  return { items, collides }
}

/** Every companion path a sidecar names, relative to the media's own folder. */
function companionFiles(meta: MediaMeta): { kind: 'script' | 'subtitle'; rel: string }[] {
  const out: { kind: 'script' | 'subtitle'; rel: string }[] = []
  for (const version of meta.scriptVersions) {
    for (const file of Object.values(version.files)) if (file) out.push({ kind: 'script', rel: file })
  }
  for (const sub of meta.subtitles) out.push({ kind: 'subtitle', rel: sub.path })
  return out
}

function planCompanion(
  ctx: RenameContext,
  companion: { kind: 'script' | 'subtitle'; rel: string },
  shared: Set<string>
): RenamePlanItem {
  const abs = resolve(ctx.mediaDir, companion.rel)
  const libRel = relative(ctx.handle.library.rootPath, abs).split('\\').join('/')
  const base = { from: companion.rel, to: companion.rel, kind: companion.kind } as RenamePlanItem

  if (dirname(abs).toLowerCase() !== ctx.mediaDir.toLowerCase()) {
    return { ...base, skipped: 'elsewhere' }
  }
  if (shared.has(libRel.toLowerCase())) return { ...base, skipped: 'shared' }
  const renamed = renamedCompanion(ctx.oldBase, ctx.newBase, companion.rel)
  if (renamed === null) return { ...base, skipped: 'unrelated' }
  return { from: companion.rel, to: renamed, kind: companion.kind }
}

export interface RenameResult {
  detail: MediaDetail
  /** Files that changed name, as `from → to` within the media's folder. */
  renamed: { from: string; to: string }[]
}

/**
 * Rename a media file, optionally taking its companions with it.
 *
 * Leaving the companions behind used to strand them: the scanner decided
 * ownership by comparing names, so scripts whose name no longer matched their
 * video became "ownerless" and grew a placeholder entry of their own on the
 * next scan. Ownership now comes from the index — whoever's sidecar names the
 * file owns it — so not renaming is a real option rather than a trap.
 */
export async function renameMedia(
  libraryId: string,
  mediaId: string,
  newName: string,
  renameCompanions: boolean
): Promise<RenameResult> {
  const ctx = await openForRename(libraryId, mediaId, newName)
  const trimmed = newName.trim()
  const newAbs = join(ctx.mediaDir, trimmed)
  const hasMediaFile = existsSync(ctx.mediaAbs)

  if (newAbs.toLowerCase() !== ctx.mediaAbs.toLowerCase() && existsSync(newAbs)) {
    throw new AppError('file_exists')
  }

  const plan = buildRenamePlan(ctx, newName, renameCompanions)
  if (plan.collides.length > 0) throw new AppError('file_exists')

  // Companions first, undoing them if the media file itself will not move:
  // a half-renamed set is worse than an unrenamed one.
  const done: { from: string; to: string }[] = []
  const undo = async (): Promise<void> => {
    for (const step of [...done].reverse()) {
      await rename(join(ctx.mediaDir, step.to), join(ctx.mediaDir, step.from)).catch(() => {})
    }
  }

  const renames = new Map<string, string>()
  try {
    for (const item of plan.items) {
      if (item.kind === 'media' || item.kind === 'sidecar') continue
      if (item.skipped !== undefined || item.from === item.to) continue
      await rename(join(ctx.mediaDir, item.from), join(ctx.mediaDir, item.to))
      done.push({ from: item.from, to: item.to })
      renames.set(item.from, item.to)
    }
    // A "wanted" entry has no media file — only the sidecar and the scripts move.
    if (hasMediaFile && newAbs.toLowerCase() !== ctx.mediaAbs.toLowerCase()) {
      await rename(ctx.mediaAbs, newAbs)
      done.push({ from: ctx.oldName, to: trimmed })
    }
  } catch (e) {
    await undo()
    throw e
  }

  const meta = applyRenames(ctx.meta, renames)
  const newRelPath = relative(ctx.handle.library.rootPath, newAbs).split('\\').join('/')
  const newSidecar = sidecarPathFor(newAbs)

  await writeSidecar(newSidecar, meta)
  const oldSidecar = sidecarPathFor(ctx.mediaAbs)
  if (oldSidecar.toLowerCase() !== newSidecar.toLowerCase() && existsSync(oldSidecar)) {
    await shell.trashItem(oldSidecar).catch(() => {})
  }

  try {
    ctx.handle.db.remove(mediaId)
    ctx.handle.db.upsertFromSidecar(meta, newRelPath, Math.floor((await stat(newSidecar)).mtimeMs))
  } catch (e) {
    console.error(`[library] index refresh failed after renaming ${ctx.relPath}:`, e)
  }
  notifyMediaChanged(libraryId)

  const detail = await getMediaDetail(libraryId, mediaId)
  if (!detail) throw new AppError('media_not_found')
  return { detail, renamed: done }
}

/** Point the sidecar at the new file names; everything else is left as it was. */
function applyRenames(meta: MediaMeta, renames: Map<string, string>): MediaMeta {
  if (renames.size === 0) return meta
  const scriptVersions: ScriptVersion[] = meta.scriptVersions.map((version) => {
    const files: Record<string, string> = {}
    for (const [axis, file] of Object.entries(version.files)) {
      if (file) files[axis] = renames.get(file) ?? file
    }
    return { ...version, files: files as ScriptVersion['files'] }
  })
  return {
    ...meta,
    scriptVersions,
    subtitles: meta.subtitles.map((s) => ({ ...s, path: renames.get(s.path) ?? s.path })),
    updatedAt: new Date().toISOString()
  }
}
