import { opendir, readdir, stat } from 'node:fs/promises'
import { AppError } from '@shared/errors'
import type { LibraryScanCache, DirectoryEntry } from '../db/scan-cache'

const MAX_SNAPSHOT_AGE_MS = 24 * 60 * 60 * 1000
// FAT/exFAT directory timestamps can have coarse resolution. Snapshots made
// inside that resolution window are relisted after it has settled.
const TIMESTAMP_WINDOW_MS = 2000

export async function assertLibraryAvailable(root: string): Promise<void> {
  try {
    const directory = await opendir(root)
    await directory.close()
  } catch (error) {
    console.warn(`[library] directory unavailable: ${root}`, error)
    throw new AppError('library_unavailable', { folder: root })
  }
}

/** Timestamp-checked listings, with watcher invalidation and a bounded lifetime. */
export async function readDirectory(
  directory: string, cache?: LibraryScanCache, optional = false
): Promise<DirectoryEntry[]> {
  let info
  try {
    info = await stat(directory)
    if (!info.isDirectory()) throw new Error('Not a directory')
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return []
    console.warn(`[library] cannot inspect directory: ${directory}`, error)
    throw new AppError('library_unavailable', { folder: directory })
  }
  const stamp = `${info.dev}:${info.ino}:${info.mtimeMs}:${info.ctimeMs}`
  const snapshot = cache?.directory(directory)
  const now = Date.now()
  if (snapshot?.stamp === stamp && snapshot.observedAt - info.mtimeMs >= TIMESTAMP_WINDOW_MS &&
    now >= snapshot.observedAt && now - snapshot.observedAt < MAX_SNAPSHOT_AGE_MS) {
    cache!.counters.directoriesReused++
    return snapshot.entries
  }
  try {
    const entries = (await readdir(directory, { withFileTypes: true })).map((entry): DirectoryEntry => ({
      name: entry.name,
      kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other'
    }))
    if (cache) {
      cache.counters.directoriesRead++
      cache.setDirectory(directory, { stamp, observedAt: now, entries })
    }
    return entries
  } catch (error) {
    console.warn(`[library] cannot list directory: ${directory}`, error)
    throw new AppError('library_unavailable', { folder: directory })
  }
}
