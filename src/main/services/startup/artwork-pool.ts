import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { z } from 'zod'
import { LIBRARY_CACHE_DIR } from '@shared/constants'
import type { RegisteredLibrary, Settings } from '@shared/schemas/app-config'
import { resolveFfmpeg } from '../deps/binaries'
import { atomicWriteJson, readJsonOr } from '../../util/atomic-json'
import { artworkCandidates, type ArtworkCandidate } from './artwork-candidates'

type Artwork = Settings['ui']['startupArtwork']

const POOL_VERSION = 1
const POOL_SIZE = 16
const PREPARE_DELAY_MS = 500
const WIDTH = 768
const HEIGHT = 880
const SEEK_SECONDS = 15
const FFMPEG_TIMEOUT_MS = 30_000

const ArtworkRefSchema = z.object({
  libraryId: z.uuid(),
  mediaId: z.uuid()
})

const ManifestSchema = z.object({
  version: z.literal(POOL_VERSION),
  selectionKey: z.string().min(1),
  anchor: ArtworkRefSchema,
  items: z.array(ArtworkRefSchema).min(1).max(POOL_SIZE),
  updatedAt: z.string()
})

type ArtworkRef = z.infer<typeof ArtworkRefSchema>
type Manifest = z.infer<typeof ManifestSchema>

interface PreparationRequest {
  key: string
  artwork: Artwork
  libraries: RegisteredLibrary[]
  anchor?: ArtworkRef
  forceNewAnchor: boolean
}

export interface ActiveArtwork {
  ref: ArtworkRef
  path: string
}

export interface ArtworkCacheProgress {
  running: boolean
  processed: number
  total: number
  ready: number
}

export interface ArtworkCacheStatus extends ArtworkCacheProgress {
  stored: number
  removable: number
}

class ArtworkPoolEmitter extends EventEmitter {
  onReady(listener: () => void): this {
    return super.on('ready', listener)
  }

  onProgress(listener: (progress: ArtworkCacheProgress) => void): this {
    return super.on('progress', listener)
  }

  emitReady(): boolean {
    return super.emit('ready')
  }

  emitProgress(progress: ArtworkCacheProgress): boolean {
    return super.emit('progress', progress)
  }
}

export const artworkPoolEvents = new ArtworkPoolEmitter()

let enabled = false
let pending: PreparationRequest | null = null
let timer: NodeJS.Timeout | null = null
let running: { key: string; abort: AbortController; promise: Promise<void> } | null = null
let manifestCache: Manifest | null | undefined
let progress: ArtworkCacheProgress = { running: false, processed: 0, total: 0, ready: 0 }

function publishProgress(next: ArtworkCacheProgress): void {
  progress = next
  artworkPoolEvents.emitProgress({ ...progress })
}

function manifestPath(): string {
  return join(app.getPath('userData'), 'startup-artwork-pool.json')
}

async function readManifest(): Promise<Manifest | null> {
  if (manifestCache !== undefined) return manifestCache
  const parsed = ManifestSchema.safeParse(await readJsonOr(manifestPath(), null))
  manifestCache = parsed.success ? parsed.data : null
  return manifestCache
}

async function writeManifest(manifest: Manifest): Promise<void> {
  await atomicWriteJson(manifestPath(), manifest)
  manifestCache = manifest
}

function selectedLibraries(
  libraries: RegisteredLibrary[],
  mediaLibraryId: string
): RegisteredLibrary[] {
  return libraries.filter((library) => !mediaLibraryId || library.id === mediaLibraryId)
}

/** Stable identity for the source set; display interval deliberately does not participate. */
export function artworkSelectionKey(
  ui: Settings['ui'],
  libraries: RegisteredLibrary[]
): string {
  const source = {
    version: POOL_VERSION,
    libraries: selectedLibraries(libraries, ui.mediaLibraryId)
      .map((library) => library.id)
      .sort(),
    tags: [...ui.startupArtwork.tags].sort(),
    playlists: [...ui.startupArtwork.playlists].sort(),
    folders: [...ui.startupArtwork.folders].sort()
  }
  return createHash('sha256').update(JSON.stringify(source)).digest('hex').slice(0, 24)
}

function refOf(candidate: ArtworkCandidate): ArtworkRef {
  return { libraryId: candidate.libraryId, mediaId: candidate.mediaId }
}

function refKey(ref: ArtworkRef): string {
  return `${ref.libraryId}:${ref.mediaId}`
}

export async function activeStartupArtwork(
  ui: Settings['ui'],
  libraries: RegisteredLibrary[]
): Promise<ActiveArtwork[]> {
  const manifest = await readManifest()
  if (!manifest || manifest.selectionKey !== artworkSelectionKey(ui, libraries)) return []
  const byId = new Map(libraries.map((library) => [library.id, library]))
  return manifest.items.flatMap((ref) => {
    const library = byId.get(ref.libraryId)
    return library
      ? [{
          ref,
          path: join(
            library.rootPath,
            LIBRARY_CACHE_DIR,
            'cache',
            'startup-artwork',
            `${ref.mediaId}.jpg`
          )
        }]
      : []
  })
}

function cancelScheduled(): void {
  if (timer) clearTimeout(timer)
  timer = null
  running?.abort.abort()
}

/**
 * Replace the pending/running pool whenever its filter identity changes.
 * Repeated requests for the same pool are cheap and leave its worker alone.
 */
export function scheduleStartupArtworkPreparation(
  ui: Settings['ui'],
  libraries: RegisteredLibrary[],
  anchor?: ArtworkRef,
  forceNewAnchor = false
): void {
  if (ui.startupArtwork.mode !== 'library') {
    pending = null
    cancelScheduled()
    publishProgress({ running: false, processed: 0, total: 0, ready: 0 })
    return
  }

  const key = artworkSelectionKey(ui, libraries)
  if (!forceNewAnchor && running?.key === key && !running.abort.signal.aborted) return
  if (!forceNewAnchor && pending?.key === key) {
    if (anchor) pending.anchor = anchor
    if (enabled) armTimer()
    return
  }

  cancelScheduled()
  pending = {
    key,
    artwork: structuredClone(ui.startupArtwork),
    libraries: selectedLibraries(libraries, ui.mediaLibraryId),
    anchor,
    forceNewAnchor
  }
  publishProgress({ running: true, processed: 0, total: 0, ready: 0 })
  if (enabled) armTimer()
}

function armTimer(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    const request = pending
    pending = null
    if (!request) return
    const abort = new AbortController()
    const promise = prepare(request, abort.signal)
      .catch((error) => console.error('[startup-artwork] preparation failed:', error))
      .finally(() => {
        if (running?.promise === promise) {
          running = null
          if (!pending) publishProgress({ ...progress, running: false })
        }
      })
    running = { key: request.key, abort, promise }
  }, PREPARE_DELAY_MS)
}

/** Generation remains disabled until the initial library sync is out of the way. */
export function enableStartupArtworkPreparation(): boolean {
  const hadPending = pending !== null
  enabled = true
  if (pending) armTimer()
  return hadPending
}

function allCandidates(request: PreparationRequest): ArtworkCandidate[] {
  return request.libraries.flatMap((library) =>
    artworkCandidates(library, request.artwork)
  )
}

function aroundAnchor(candidates: ArtworkCandidate[], anchorIndex: number): ArtworkCandidate[] {
  const count = Math.min(POOL_SIZE, candidates.length)
  const before = Math.floor((count - 1) / 2)
  const cohort: ArtworkCandidate[] = []
  for (let offset = -before; cohort.length < count; offset++) {
    cohort.push(candidates[(anchorIndex + offset + candidates.length) % candidates.length]!)
  }
  return cohort
}

function generationOrder(
  cohort: ArtworkCandidate[],
  anchor: ArtworkRef
): ArtworkCandidate[] {
  const anchorIndex = Math.max(0, cohort.findIndex((candidate) => refKey(refOf(candidate)) === refKey(anchor)))
  const ordered: ArtworkCandidate[] = [cohort[anchorIndex]!]
  for (let distance = 1; ordered.length < cohort.length; distance++) {
    const after = cohort[anchorIndex + distance]
    const before = cohort[anchorIndex - distance]
    if (after) ordered.push(after)
    if (before) ordered.push(before)
  }
  return ordered
}

async function prepare(request: PreparationRequest, signal: AbortSignal): Promise<void> {
  const candidates = allCandidates(request)
  if (signal.aborted || candidates.length === 0) return

  const previous = await readManifest()
  const byRef = new Map(candidates.map((candidate) => [refKey(refOf(candidate)), candidate]))
  let cohort: ArtworkCandidate[]
  let anchor: ArtworkRef
  let reusePrevious = false

  if (!request.forceNewAnchor && previous?.selectionKey === request.key) {
    const previousAnchor = byRef.get(refKey(previous.anchor))
    if (previousAnchor) {
      const index = candidates.indexOf(previousAnchor)
      anchor = previous.anchor
      cohort = aroundAnchor(candidates, index)
      reusePrevious =
        cohort.length === previous.items.length &&
        cohort.every((candidate, itemIndex) =>
          refKey(refOf(candidate)) === refKey(previous.items[itemIndex]!)
        )
    } else {
      const index = Math.floor(Math.random() * candidates.length)
      anchor = refOf(candidates[index]!)
      cohort = aroundAnchor(candidates, index)
    }
  } else {
    const requestedIndex = request.anchor
      ? candidates.findIndex((candidate) => refKey(refOf(candidate)) === refKey(request.anchor!))
      : -1
    const index = requestedIndex >= 0 ? requestedIndex : Math.floor(Math.random() * candidates.length)
    anchor = refOf(candidates[index]!)
    cohort = aroundAnchor(candidates, index)
  }

  if (signal.aborted || cohort.length === 0) return
  publishProgress({ running: true, processed: 0, total: cohort.length, ready: 0 })
  const ffmpeg = await resolveFfmpeg()
  let activated = reusePrevious
  let announced = activated && await hasFreshArtwork(cohort)

  for (const candidate of generationOrder(cohort, anchor)) {
    if (signal.aborted) return
    const ready = await ensureArtwork(candidate, ffmpeg, signal)
    if (signal.aborted) return
    if (ready) {
      if (!activated) {
        await writeManifest({
          version: POOL_VERSION,
          selectionKey: request.key,
          anchor,
          items: cohort.map(refOf),
          updatedAt: new Date().toISOString()
        })
        activated = true
      }
      if (!announced) {
        artworkPoolEvents.emitReady()
        announced = true
      }
    }
    publishProgress({
      running: true,
      processed: progress.processed + 1,
      total: cohort.length,
      ready: progress.ready + (ready ? 1 : 0)
    })
  }
}

async function hasFreshArtwork(candidates: ArtworkCandidate[]): Promise<boolean> {
  for (const candidate of candidates) {
    if (await isFresh(candidate)) return true
  }
  return false
}

async function isFresh(candidate: ArtworkCandidate): Promise<boolean> {
  try {
    const [source, cached] = await Promise.all([stat(candidate.mediaPath), stat(candidate.highResPath)])
    return source.isFile() && cached.isFile() && cached.size > 0 && cached.mtimeMs >= source.mtimeMs
  } catch {
    return false
  }
}

async function ensureArtwork(
  candidate: ArtworkCandidate,
  ffmpeg: string | null,
  signal: AbortSignal
): Promise<boolean> {
  if (await isFresh(candidate)) return true
  if (!ffmpeg || signal.aborted) return false
  await mkdir(dirname(candidate.highResPath), { recursive: true })
  const temp = `${candidate.highResPath}.tmp`
  const args = (seek: number): string[] => [
    '-y',
    ...(seek > 0 ? ['-ss', String(seek)] : []),
    '-i', candidate.mediaPath,
    '-frames:v', '1',
    '-vf', `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT}`,
    '-q:v', '3',
    '-f', 'image2',
    temp
  ]

  let ok = await runFfmpeg(ffmpeg, args(SEEK_SECONDS), signal)
  if (ok) ok = await hasContent(temp)
  if (!ok && !signal.aborted) {
    ok = await runFfmpeg(ffmpeg, args(0), signal)
    if (ok) ok = await hasContent(temp)
  }
  if (!ok || signal.aborted) {
    await unlink(temp).catch(() => {})
    return false
  }
  await unlink(candidate.highResPath).catch(() => {})
  await rename(temp, candidate.highResPath)
  return true
}

function runFfmpeg(exe: string, args: string[], signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false)
      return
    }
    const proc = spawn(exe, args, { windowsHide: true, stdio: 'ignore' })
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      resolve(ok)
    }
    const abort = (): void => {
      proc.kill()
      finish(false)
    }
    const timeout = setTimeout(() => {
      proc.kill()
      finish(false)
    }, FFMPEG_TIMEOUT_MS)
    signal.addEventListener('abort', abort, { once: true })
    proc.once('error', () => finish(false))
    proc.once('exit', (code) => finish(code === 0 && !signal.aborted))
  })
}

async function hasContent(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0
  } catch {
    return false
  }
}

interface CacheFile {
  key: string
  path: string
}

async function cacheFiles(libraries: RegisteredLibrary[]): Promise<CacheFile[]> {
  const files: CacheFile[] = []
  for (const library of libraries) {
    const folder = join(library.rootPath, LIBRARY_CACHE_DIR, 'cache', 'startup-artwork')
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jpg')) continue
      const mediaId = entry.name.slice(0, -4)
      if (!z.uuid().safeParse(mediaId).success) continue
      files.push({ key: `${library.id}:${mediaId}`, path: join(folder, entry.name) })
    }
  }
  return files
}

async function activeKeys(
  ui: Settings['ui'],
  libraries: RegisteredLibrary[]
): Promise<Set<string>> {
  const manifest = await readManifest()
  if (!manifest || manifest.selectionKey !== artworkSelectionKey(ui, libraries)) return new Set()
  return new Set(manifest.items.map(refKey))
}

export async function startupArtworkCacheStatus(
  ui: Settings['ui'],
  libraries: RegisteredLibrary[]
): Promise<ArtworkCacheStatus> {
  const [files, active] = await Promise.all([cacheFiles(libraries), activeKeys(ui, libraries)])
  return {
    ...progress,
    stored: files.length,
    removable: files.filter((file) => !active.has(file.key)).length
  }
}

/** Explicit cleanup only: prepared images otherwise remain alongside thumbnails indefinitely. */
export async function clearUnusedStartupArtwork(
  ui: Settings['ui'],
  libraries: RegisteredLibrary[]
): Promise<ArtworkCacheStatus> {
  if (progress.running) return startupArtworkCacheStatus(ui, libraries)
  const [files, active] = await Promise.all([cacheFiles(libraries), activeKeys(ui, libraries)])
  await Promise.all(files
    .filter((file) => !active.has(file.key))
    .map((file) => unlink(file.path).catch(() => {})))
  return startupArtworkCacheStatus(ui, libraries)
}

export async function disposeStartupArtworkPreparation(): Promise<void> {
  pending = null
  cancelScheduled()
  await running?.promise
  running = null
}
