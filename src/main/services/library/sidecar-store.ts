import { constants as fsConstants, existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rm, rmdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { shell } from 'electron'
import { LIBRARY_META_DIR, SIDECAR_SUFFIX } from '@shared/constants'
import type { MediaMeta } from '@shared/schemas/media-meta'
import type { MetaLocation, MetaState } from '@shared/schemas/library-state'
import { libraryDataDir, type LibraryStateFile } from './library-state-file'
import { besideSidecarPath, readSidecar, writeSidecar, type SidecarReadResult } from './sidecar'

/**
 * Where one library's sidecars are, and where they go.
 *
 * A library writes its sidecars to one place — beside the media, or in a mirror
 * folder (see MetaLocationSchema) — but reads them from every place they could
 * be. Switching the location therefore never hides an entry: whatever has not
 * been moved yet is still found where it was, the scanner moves it across a
 * batch at a time, and a move cut short by closing the app simply carries on
 * at the next scan, because the files themselves are the record of what is
 * left to do.
 *
 * Every sidecar read or write in the app goes through here. A path built by
 * hand from the media path is a path in the wrong place for every library that
 * is not kept beside its media.
 */

export const DEFAULT_META_STATE: MetaState = { location: 'beside', customDir: '', leftoverDirs: [] }

function samePath(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase()
}

/** `dir` itself, or anything under it. */
export function isWithin(dir: string, path: string): boolean {
  const rel = relative(dir, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export class SidecarStore {
  /**
   * Bumped whenever the location changes. A batch of moves started under an
   * older one stops, rather than carrying files the way the user just turned
   * away from.
   */
  generation = 0
  /** Sidecars not yet in the chosen location, as of the last scan. */
  pending = 0

  constructor(
    readonly libraryRoot: string,
    private readonly stateFile: LibraryStateFile
  ) {}

  get state(): MetaState {
    return this.stateFile.metadata ?? DEFAULT_META_STATE
  }

  get location(): MetaLocation {
    return this.state.location
  }

  async setState(next: MetaState): Promise<void> {
    await this.stateFile.setMetadata(next)
    this.generation += 1
  }

  /** `.fsmgr/meta` in this library. */
  libraryMirror(): string {
    return join(libraryDataDir(this.libraryRoot), LIBRARY_META_DIR)
  }

  /** The mirror folder sidecars are written to; null when they go beside the media. */
  targetMirror(): string | null {
    const { location, customDir } = this.state
    if (location === 'library') return this.libraryMirror()
    if (location === 'custom' && customDir) return customDir
    return null
  }

  /**
   * Every mirror folder that may hold sidecars, the target first. The library's
   * own is always read: it costs one missing-folder check when unused, and it
   * is where a newer build or another install may have put them.
   */
  mirrors(): string[] {
    const { customDir, leftoverDirs } = this.state
    const all = [this.targetMirror(), this.libraryMirror(), customDir || null, ...leftoverDirs]
    const out: string[] = []
    for (const dir of all) {
      if (dir && !out.some((d) => samePath(d, dir))) out.push(dir)
    }
    return out
  }

  /**
   * Folders outside the library that hold (or should hold) sidecars and cannot
   * be reached. Nothing is scanned while one is listed: without the sidecars in
   * it, every entry they belong to would be ingested again as new.
   */
  unreachable(): string[] {
    const { location, customDir, leftoverDirs } = this.state
    const outside = [...(location === 'custom' ? [customDir] : []), ...leftoverDirs]
    return outside.filter((dir) => !dir || !existsSync(dir))
  }

  /**
   * Forget leftover folders that are gone for good: the drive is there and the
   * folder is not, so there is nothing left in it to move. One whose drive is
   * missing is kept — it is most likely unplugged, and its sidecars still to come.
   */
  async dropVanishedLeftovers(): Promise<void> {
    const { leftoverDirs } = this.state
    const kept = leftoverDirs.filter((dir) => existsSync(dir) || !existsSync(parse(resolve(dir)).root))
    if (kept.length !== leftoverDirs.length) {
      await this.stateFile.setMetadata({ ...this.state, leftoverDirs: kept })
    }
  }

  /**
   * Remove mirror folders the library has moved out of once no sidecar is left
   * in them: leftover folders, and the library's own when it is not the target.
   * Whatever else is in them is left alone, and so is the folder.
   */
  async retireEmptyMirrors(): Promise<void> {
    const target = this.targetMirror()
    const retired: string[] = []
    for (const dir of [this.libraryMirror(), ...this.state.leftoverDirs]) {
      if (target && samePath(dir, target)) continue
      if (!existsSync(dir)) {
        retired.push(dir)
        continue
      }
      if (await holdsFiles(dir)) continue
      try {
        await rm(dir, { recursive: true })
        retired.push(dir)
      } catch (e) {
        console.error(`[library] could not remove the emptied folder ${dir}:`, e)
      }
    }
    const { leftoverDirs } = this.state
    const kept = leftoverDirs.filter((d) => !retired.some((r) => samePath(r, d)))
    if (kept.length !== leftoverDirs.length) {
      await this.stateFile.setMetadata({ ...this.state, leftoverDirs: kept })
    }
  }

  /** The media's sidecar path in one mirror folder, or beside it for null. */
  pathIn(mirror: string | null, mediaAbs: string): string {
    if (mirror === null) return besideSidecarPath(mediaAbs)
    const rel = relative(this.libraryRoot, mediaAbs)
    // Only media inside the library have a place in a mirror.
    if (rel.startsWith('..') || isAbsolute(rel)) return besideSidecarPath(mediaAbs)
    return join(mirror, rel) + SIDECAR_SUFFIX
  }

  /** Where this media's sidecar is written. */
  target(mediaAbs: string): string {
    return this.pathIn(this.targetMirror(), mediaAbs)
  }

  /**
   * Every place this media's sidecar could be, the target first and beside the
   * media last. Of two copies elsewhere, the one in a mirror folder wins: only
   * this build writes those, while one beside the media may be a blank that an
   * older build wrote because it could not see the mirror.
   */
  candidates(mediaAbs: string): string[] {
    const out = [this.target(mediaAbs)]
    for (const path of [
      ...this.mirrors().map((m) => this.pathIn(m, mediaAbs)),
      besideSidecarPath(mediaAbs)
    ]) {
      if (!out.some((p) => samePath(p, path))) out.push(path)
    }
    return out
  }

  /** The sidecar that exists, preferring the target; the target when there is none. */
  locate(mediaAbs: string): string {
    return this.candidates(mediaAbs).find((p) => existsSync(p)) ?? this.target(mediaAbs)
  }

  exists(mediaAbs: string): boolean {
    return this.candidates(mediaAbs).some((p) => existsSync(p))
  }

  read(mediaAbs: string): Promise<SidecarReadResult> {
    return readSidecar(this.locate(mediaAbs))
  }

  /**
   * Write the media's sidecar to the target and drop any copy elsewhere (see
   * dropCopy). Returns the path written.
   */
  async write(mediaAbs: string, meta: MediaMeta): Promise<string> {
    const target = this.target(mediaAbs)
    await writeSidecar(target, meta)
    for (const path of this.candidates(mediaAbs).slice(1)) await this.dropCopy(path, meta.id)
    return target
  }

  /** Remove every copy of this media's sidecar. */
  async removeAll(mediaAbs: string): Promise<void> {
    for (const path of this.candidates(mediaAbs)) await this.removeFile(path)
  }

  /** Every copy of this media's sidecar that exists. */
  existing(mediaAbs: string): string[] {
    return this.candidates(mediaAbs).filter((p) => existsSync(p))
  }

  /** A sidecar's path as the user should see it: library-relative when it is in the library. */
  displayPath(sidecarAbs: string): string {
    return isWithin(this.libraryRoot, sidecarAbs)
      ? relative(this.libraryRoot, sidecarAbs).split(sep).join('/')
      : sidecarAbs
  }

  /**
   * Move one sidecar to where it now belongs, never over one already there.
   *
   * `conflict` means the destination already had one: the destination's copy
   * is the one the library uses, and the other is dropped (see dropCopy).
   * That happens when an older build, which only knows sidecars beside the
   * media, found none there and wrote blank ones — moving those over the real
   * ones would lose everything the user set.
   */
  async move(from: string, to: string): Promise<'moved' | 'conflict' | 'gone'> {
    await mkdir(dirname(to), { recursive: true })
    try {
      // Copy, not rename: rename would replace a sidecar already at `to`, and
      // it cannot cross to a folder on another drive.
      await copyFile(from, to, fsConstants.COPYFILE_EXCL)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return 'gone'
      if (code !== 'EEXIST') throw e
      await this.dropCopy(from, await idOf(to))
      return 'conflict'
    }
    await this.removeFile(from)
    return 'moved'
  }

  /** Recycle Bin, or left where it is when the shell will not take it. */
  async discard(path: string): Promise<void> {
    try {
      await shell.trashItem(path)
      await this.pruneAbove(path)
    } catch (e) {
      console.error(`[library] could not move ${path} to the Recycle Bin:`, e)
    }
  }

  /**
   * Get rid of a copy that lost to the one the library uses. An older copy of
   * the same entry is simply stale and is deleted. A copy of a different entry
   * is somebody's data — typically a blank an older build wrote — and goes to
   * the Recycle Bin, so a wrong call here can still be undone.
   */
  async dropCopy(path: string, keptId: string | null): Promise<void> {
    if (!existsSync(path)) return
    if (keptId !== null && (await idOf(path)) === keptId) await this.removeFile(path)
    else await this.discard(path)
  }

  private async removeFile(path: string): Promise<void> {
    if (!existsSync(path)) return
    await rm(path, { force: true })
    await this.pruneAbove(path)
  }

  /**
   * Remove the folders a removed sidecar leaves empty, up to its mirror root.
   * Folders beside the media are the user's and are never touched; neither is
   * the mirror root, which stays for the next sidecar.
   */
  private async pruneAbove(path: string): Promise<void> {
    const mirror = this.mirrors().find((m) => isWithin(m, path) && !samePath(m, path))
    if (!mirror) return
    for (let dir = dirname(path); !samePath(dir, mirror) && isWithin(mirror, dir); dir = dirname(dir)) {
      try {
        await rmdir(dir)
      } catch {
        return // not empty, or already gone: either way nothing above it is empty
      }
    }
  }
}

/** The entry id a sidecar file carries, or null when it cannot be read. */
async function idOf(path: string): Promise<string | null> {
  try {
    const id = (JSON.parse(await readFile(path, 'utf-8')) as { id?: unknown } | null)?.id
    return typeof id === 'string' ? id : null
  } catch {
    return null
  }
}

/** Is there any file under this folder, however deep? */
async function holdsFiles(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory()) return true
    if (await holdsFiles(join(dir, entry.name))) return true
  }
  return false
}

/**
 * The running libraries' stores, by root. Code that holds a media path but not
 * a library handle — playback, the picture's VR menu — finds its store here.
 */
const stores = new Map<string, SidecarStore>()

export function registerSidecarStore(store: SidecarStore): void {
  stores.set(resolve(store.libraryRoot).toLowerCase(), store)
}

export function unregisterSidecarStore(libraryRoot: string): void {
  stores.delete(resolve(libraryRoot).toLowerCase())
}

/** The store of the library that contains this media, the innermost one if several do. */
export function sidecarStoreForMedia(mediaAbs: string): SidecarStore | null {
  let best: SidecarStore | null = null
  for (const store of stores.values()) {
    if (!isWithin(store.libraryRoot, mediaAbs)) continue
    if (!best || store.libraryRoot.length > best.libraryRoot.length) best = store
  }
  return best
}

/**
 * Read a media's sidecar from wherever its library keeps it. A media outside
 * every running library can only have one beside it.
 */
export function readMediaSidecar(mediaAbs: string): Promise<SidecarReadResult> {
  const store = sidecarStoreForMedia(mediaAbs)
  return store ? store.read(mediaAbs) : readSidecar(besideSidecarPath(mediaAbs))
}

/** Write a media's sidecar to wherever its library keeps them. */
export async function writeMediaSidecar(mediaAbs: string, meta: MediaMeta): Promise<void> {
  const store = sidecarStoreForMedia(mediaAbs)
  if (store) await store.write(mediaAbs, meta)
  else await writeSidecar(besideSidecarPath(mediaAbs), meta)
}

/** A folder some library keeps sidecars in, other than its own `.fsmgr/meta`. */
export function isOutsideMirror(dir: string): boolean {
  for (const store of stores.values()) {
    const { customDir, leftoverDirs } = store.state
    if ([customDir, ...leftoverDirs].some((d) => d && samePath(d, dir))) return true
  }
  return false
}

/** Every running library's root, for keeping a sidecar folder out of all of them. */
export function runningLibraryRoots(): string[] {
  return [...stores.values()].map((s) => s.libraryRoot)
}
