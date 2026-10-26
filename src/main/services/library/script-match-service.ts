import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, mkdir, realpath, stat, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { FUNSCRIPT_EXTENSION, LIBRARY_CACHE_DIR, LIBRARY_DATA_DIR } from '@shared/constants'
import { AppError } from '@shared/errors'
import type { MediaMeta, ScriptVersion } from '@shared/schemas/media-meta'
import type {
  ScriptMatchApplyResult, ScriptMatchChoice, ScriptMatchPreview
} from '@shared/schemas/script-match'
import { getSettings } from '../config/config-service'
import { awaitingPairKeys, isBusyFor } from '../downloaders/queue'
import { mediaBasename, parseFunscript, scriptVersionName } from './companion-grouping'
import {
  editMedia, internalHandle, mergeWantedInto, runLibraryTask, refreshLibraryWatcher,
  type InternalLibraryHandle
} from './library-manager'
import { isOutsideMirror, isWithin } from './sidecar-store'
import { readDirectory } from './directory-reader'
import {
  automaticScriptTarget, rankScriptCandidates, scriptFamilies,
  scriptPathKey, suggestedScriptTarget,
  type RankedScriptCandidate, type ScriptMatchMedia, type ScriptMatchSource
} from './script-matching'

interface PlannedGroup {
  source: ScriptMatchSource
  candidates: RankedScriptCandidate[]
}

interface MatchPlan {
  groups: PlannedGroup[]
  preview: ScriptMatchPreview
}

/** Enumerate regular files only; symlinks cannot grant access to another tree. */
async function scriptDirectories(
  roots: string[], handle: InternalLibraryHandle
): Promise<{ directories: Map<string, string[]>; unreachable: string[] }> {
  const directories = new Map<string, string[]>()
  const unreachable: string[] = []
  const visited = new Set<string>()
  const stack = [...roots]
  while (stack.length) {
    const directory = stack.pop()!
    const key = scriptPathKey(directory)
    if (visited.has(key)) continue
    visited.add(key)
    let entries
    try {
      entries = await readDirectory(directory, handle.db.scanCache)
    } catch {
      unreachable.push(directory)
      continue
    }
    const names: string[] = []
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === LIBRARY_CACHE_DIR) continue
      const path = join(directory, entry.name)
      if (entry.kind === 'directory') {
        if (!isOutsideMirror(path)) stack.push(path)
      } else if (entry.kind === 'file' && entry.name.toLowerCase().endsWith(FUNSCRIPT_EXTENSION)) {
        const rel = relative(handle.library.rootPath, path).split(sep).join('/')
        if (isWithin(handle.library.rootPath, path) && handle.ignored.hasCompanion(rel)) continue
        names.push(entry.name)
      }
    }
    if (names.length) directories.set(directory, names)
  }
  return { directories, unreachable }
}

async function planMatches(libraryId: string, includeExternal: boolean, inventory?: Map<string, string[]>): Promise<MatchPlan> {
  const handle = internalHandle(libraryId)
  const root = handle.library.rootPath
  const folders = handle.state.scriptFolders
  const blocked = new Set<string>()
  const media: ScriptMatchMedia[] = []
  const sources: ScriptMatchSource[] = []
  const versionsByMain = new Map<string, { mediaId: string; version: ScriptVersion; missing: boolean }[]>()
  // Missing real entries still own their scripts. A temporary unplug must not
  // transfer a manually assigned version to a different video.
  for (const row of handle.db.listIndexed()) {
    const mediaAbs = resolve(root, row.filePath)
    const read = await handle.store.read(mediaAbs)
    if (!read.ok) continue
    const meta = read.meta
    const directory = dirname(mediaAbs)
    const paths = meta.scriptVersions.flatMap((version) => Object.values(version.files))
      .filter((path): path is string => Boolean(path)).map((path) => resolve(directory, path))
    paths.forEach((path) => blocked.add(scriptPathKey(path)))
    for (const version of meta.scriptVersions) {
      if (!meta.wanted && version.files.main) {
        const key = scriptPathKey(resolve(directory, version.files.main))
        const owners = versionsByMain.get(key) ?? []
        owners.push({ mediaId: row.id, version, missing: row.missing })
        versionsByMain.set(key, owners)
      }
      Object.values(version.importedFrom ?? {}).forEach((path) => {
        if (path) blocked.add(scriptPathKey(path))
      })
    }
    if (meta.wanted) {
      const main = meta.scriptVersions[0]?.files.main
      if (!main || !paths.length || paths.some((path) => !isWithin(root, path))) continue
      sources.push({
        id: meta.id, sourceId: meta.id, directory,
        files: meta.scriptVersions[0]!.files,
        paths,
        mainNames: meta.scriptVersions.map((version) => basename(version.files.main!)),
        dismissed: meta.wanted.dismissed,
        copy: false
      })
    } else if (!row.missing) {
      media.push({ mediaId: row.id, filePath: row.filePath, directory })
    }
  }
  for (const key of awaitingPairKeys(libraryId, root)) blocked.add(scriptPathKey(resolve(root, key)))
  // A removed entry's sidecar remains on disk. Its imported sources must stay
  // removed too, even though the entry is no longer present in the index.
  for (const entry of handle.ignored.list()) {
    const read = await handle.store.read(resolve(root, entry.path))
    if (!read.ok) continue
    for (const version of read.meta.scriptVersions) {
      Object.values(version.importedFrom ?? {}).forEach((path) => {
        if (path) blocked.add(scriptPathKey(path))
      })
    }
  }
  const { directories, unreachable } = await scriptDirectories(
    [...(inventory ? [] : [root]), ...(includeExternal ? folders : [])], handle
  )
  if (inventory) for (const [directory, names] of inventory) directories.set(directory, names)
  for (const [directory, names] of directories) {
    // Build complete families first: an already owned main must not donate
    // its unclaimed secondary axes to another entry.
    for (const source of scriptFamilies(directory, names, !isWithin(root, directory))) {
      if (!source.paths.some((path) => blocked.has(scriptPathKey(path)))) {
        sources.push(source)
        continue
      }
      if (source.copy) continue
      const owners = versionsByMain.get(scriptPathKey(resolve(directory, source.files.main!))) ?? []
      const owner = owners.length === 1 ? owners[0] : undefined
      if (!owner || owner.missing) continue
      const additions = Object.entries(source.files).filter(([axis, file]) =>
        axis !== 'main' && file && !owner.version.files[axis as keyof ScriptVersion['files']] &&
        !blocked.has(scriptPathKey(resolve(directory, file)))
      )
      if (!additions.length) continue
      const files = { main: source.files.main!, ...Object.fromEntries(additions) }
      sources.push({ ...source, id: `${source.id}:${owner.version.id}`,
        versionId: owner.version.id, targetId: owner.mediaId,
        files, paths: Object.values(files).map((file) => resolve(directory, file!)) })
    }
  }
  const level = (await getSettings()).library.companionMatch
  const groups: PlannedGroup[] = []
  let unmatched = 0
  for (const source of sources) {
    // A placeholder may overlap a real entry after an interrupted merge. It
    // must not offer that real entry's files to a third video.
    const usedElsewhere = source.sourceId && handle.db.filesOf(source.sourceId).some((file) =>
      handle.db.othersUsing([file.path], [source.sourceId!]).some((user) => !user.wanted)
    )
    if (usedElsewhere) continue
    const candidates = rankScriptCandidates(source, media, level)
    if (!candidates.length) { unmatched++; continue }
    groups.push({ source, candidates })
  }
  groups.sort((a, b) => a.source.paths[0]!.localeCompare(b.source.paths[0]!))
  const display = (path: string): string => isWithin(root, path)
    ? relative(root, path).split(sep).join('/') : path
  return {
    groups,
    preview: {
      folders, unreachable, unmatched,
      groups: groups.map(({ source, candidates }) => ({
        id: source.id,
        scriptPath: display(resolve(source.directory, source.files.main!)),
        files: source.paths.map(display),
        copy: source.copy,
        candidates: candidates.map(({ mediaId, filePath, kind }) => ({ mediaId, filePath, kind })),
        suggestedMediaId: suggestedScriptTarget(candidates)
      }))
    }
  }
}

/** Check again at apply time: a preview is not permission to read an arbitrary path. */
async function validateSource(source: ScriptMatchSource, handle: InternalLibraryHandle): Promise<void> {
  for (const path of source.paths) {
    const actual = await realpath(path)
    const allowed = [handle.library.rootPath, ...handle.state.scriptFolders]
    if (!allowed.some((folder) => isWithin(folder, actual)) || !(await stat(actual)).isFile()) {
      throw new AppError('script_file_not_found', { file: basename(path) })
    }
  }
}

async function attachGroup(libraryId: string, group: PlannedGroup, mediaId: string): Promise<void> {
  const handle = internalHandle(libraryId)
  const { source } = group
  await validateSource(source, handle)
  const relPath = handle.db.getMediaRelPath(mediaId)
  if (!relPath) throw new AppError('media_not_found')
  const mediaAbs = resolve(handle.library.rootPath, relPath)
  if (!(await stat(mediaAbs)).isFile()) throw new AppError('media_not_found')
  const current = await handle.store.read(mediaAbs)
  if (!current.ok || current.meta.wanted) throw new AppError('media_not_found')
  const relPaths = source.paths.map((path) => relative(handle.library.rootPath, path).split(sep).join('/'))
  const otherOwners = handle.db.othersUsing(relPaths, source.sourceId ? [source.sourceId, mediaId] : [mediaId])
  if (otherOwners.some((owner) => !owner.wanted)) throw new AppError('script_version_merge_invalid')
  if (source.versionId) {
    await editMedia(libraryId, mediaId, (meta) => {
      const version = meta.scriptVersions.find((item) => item.id === source.versionId)
      if (!version || !version.files.main || scriptPathKey(resolve(dirname(mediaAbs), version.files.main)) !==
        scriptPathKey(resolve(source.directory, source.files.main!))) throw new AppError('script_version_not_found')
      const files = { ...version.files }
      for (const [axis, name] of Object.entries(source.files)) {
        const key = axis as keyof ScriptVersion['files']
        if (name && !files[key]) files[key] = relative(dirname(mediaAbs), resolve(source.directory, name)).split(sep).join('/')
      }
      return { ...meta, scriptVersions: meta.scriptVersions.map((item) => item.id === version.id ? { ...item, files } : item),
        updatedAt: new Date().toISOString() }
    })
    return
  }
  if (source.sourceId) {
    await mergeWantedInto(libraryId, mediaId, [source.sourceId])
    return
  }
  const mediaDir = dirname(mediaAbs)
  const files: Record<string, string> = {}
  const importedFrom: Record<string, string> = {}
  const copies: string[] = []
  const copyDir = source.copy
    ? join(handle.library.rootPath, LIBRARY_DATA_DIR, 'scripts', randomUUID()) : null
  try {
    if (copyDir) await mkdir(copyDir, { recursive: true })
    for (const [axis, name] of Object.entries(source.files)) {
      if (!name) continue
      const original = resolve(source.directory, name)
      const destination = copyDir ? join(copyDir, basename(name)) : original
      if (copyDir) {
        await copyFile(original, destination, constants.COPYFILE_EXCL)
        copies.push(destination)
        importedFrom[axis] = original
      }
      files[axis] = relative(mediaDir, destination).split(sep).join('/')
    }
    const parsed = parseFunscript(mediaBasename(basename(relPath)), source.files.main!,
      (await getSettings()).library.companionMatch)
    await editMedia(libraryId, mediaId, (meta: MediaMeta) => {
      const version: ScriptVersion = {
        id: randomUUID(),
        name: parsed?.versionKey || scriptVersionName(source.files.main!),
        files: files as ScriptVersion['files'],
        isDefault: meta.scriptVersions.length === 0,
        ...(copyDir ? { importedFrom } : {})
      }
      return { ...meta, scriptVersions: [...meta.scriptVersions, version], updatedAt: new Date().toISOString() }
    })
  } catch (error) {
    // A post-write index failure can reject an edit that has already landed.
    // Never remove copies that the durable sidecar now references.
    const saved = await handle.store.read(mediaAbs).catch(() => null)
    if (saved?.ok) {
      const held = new Set(saved.meta.scriptVersions.flatMap((version) => Object.values(version.files))
        .filter((file): file is string => Boolean(file)).map((file) => scriptPathKey(resolve(mediaDir, file))))
      for (const path of copies) {
        if (!held.has(scriptPathKey(path))) await unlink(path).catch(() => {})
      }
    }
    throw error
  }
}

const pendingPreviews = new Map<string, Promise<ScriptMatchPreview>>()

export function previewScriptMatches(libraryId: string): Promise<ScriptMatchPreview> {
  const pending = pendingPreviews.get(libraryId)
  if (pending) return pending
  // A scan can attach thousands of scripts and emit a change for each one.
  // Review windows share one queued read instead of queuing another full walk
  // for every event while the scan is still busy writing.
  const run = runLibraryTask(libraryId, async () => (await planMatches(libraryId, true)).preview)
  pendingPreviews.set(libraryId, run)
  const clear = (): void => { if (pendingPreviews.get(libraryId) === run) pendingPreviews.delete(libraryId) }
  void run.then(clear, clear)
  return run
}

export function applyScriptMatches(
  libraryId: string, choices: ScriptMatchChoice[]
): Promise<ScriptMatchApplyResult> {
  return runLibraryTask(libraryId, async () => {
    const plan = await planMatches(libraryId, true)
    const byId = new Map(plan.groups.map((group) => [group.source.id, group]))
    const result: ScriptMatchApplyResult = { applied: 0, skipped: 0, failed: 0 }
    const seen = new Set<string>()
    for (const choice of choices) {
      const group = byId.get(choice.groupId)
      if (seen.has(choice.groupId) || !group ||
        !group.candidates.some((candidate) => candidate.mediaId === choice.mediaId)) {
        result.skipped++
        continue
      }
      seen.add(choice.groupId)
      try {
        await attachGroup(libraryId, group, choice.mediaId)
        result.applied++
      } catch (error) {
        result.failed++
        console.warn(`[script-match] ${choice.groupId}:`, error)
      }
    }
    return result
  })
}

/** Runs inside the library's sync queue; external sources always need confirmation. */
export async function autoMatchLibraryScripts(libraryId: string, inventory?: Map<string, string[]>): Promise<void> {
  if (isBusyFor(libraryId)) return
  const plan = await planMatches(libraryId, false, inventory)
  for (const group of plan.groups) {
    const target = automaticScriptTarget(group.source, group.candidates)
    if (!target) continue
    try {
      await attachGroup(libraryId, group, target)
    } catch (error) {
      console.warn(`[script-match] auto ${group.source.id}:`, error)
    }
  }
}

export function setScriptFolders(libraryId: string, folders: string[]): Promise<void> {
  return runLibraryTask(libraryId, async () => {
    const handle = internalHandle(libraryId)
    const unique = new Map<string, string>()
    for (const folder of folders) {
      if (!isAbsolute(folder)) throw new AppError('library_path_invalid', { path: folder })
      const path = resolve(folder)
      if (isWithin(handle.library.rootPath, path) || isWithin(path, handle.library.rootPath)) {
        throw new AppError('library_path_invalid', { path })
      }
      unique.set(scriptPathKey(path), path)
    }
    await handle.state.setScriptFolders([...unique.values()])
    await refreshLibraryWatcher(libraryId)
  })
}
