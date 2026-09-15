import { join } from 'node:path'
import { LIBRARY_STATE_JSON } from '@shared/constants'
import {
  LibraryStateSchema,
  type IgnoredEntry,
  type LibraryState
} from '@shared/schemas/library-state'
import { atomicWriteJson, readJsonOr } from '../../util/atomic-json'

/**
 * The list of entries the user removed from the library without deleting their
 * files (see LibraryStateSchema).
 *
 * Kept in memory per library and written through on every change: the scanner
 * asks it once per file, and going to disk for that would make a scan of a big
 * library thousands of reads slower for no reason.
 */

export function libraryStatePath(libraryRoot: string): string {
  return join(libraryRoot, LIBRARY_STATE_JSON)
}

/** Case-insensitive, forward slashes — the form paths are compared in. */
function key(relPath: string): string {
  return relPath.split('\\').join('/').toLowerCase()
}

export class IgnoreList {
  private byFingerprint = new Map<string, IgnoredEntry>()
  private byPath = new Map<string, IgnoredEntry>()
  private companions = new Set<string>()

  private constructor(
    private readonly libraryRoot: string,
    private entries: IgnoredEntry[]
  ) {
    this.reindex()
  }

  static async load(libraryRoot: string): Promise<IgnoreList> {
    const raw = await readJsonOr(libraryStatePath(libraryRoot), null)
    if (raw === null) return new IgnoreList(libraryRoot, [])
    const parsed = LibraryStateSchema.safeParse(raw)
    // An unreadable state file must not be overwritten — it is the only copy of
    // a decision the user made — but it also must not stop the library opening.
    return new IgnoreList(libraryRoot, parsed.success ? parsed.data.ignored : [])
  }

  private reindex(): void {
    this.byFingerprint = new Map()
    this.byPath = new Map()
    this.companions = new Set()
    for (const entry of this.entries) {
      if (entry.fingerprint) this.byFingerprint.set(entry.fingerprint, entry)
      this.byPath.set(key(entry.path), entry)
      for (const companion of entry.companions) this.companions.add(key(companion))
    }
  }

  // One write at a time, so a slow one cannot land on top of a newer one.
  private writes: Promise<unknown> = Promise.resolve()

  private save(): Promise<void> {
    const state: LibraryState = { schemaVersion: 1, ignored: [...this.entries] }
    const run = this.writes.then(() =>
      atomicWriteJson(libraryStatePath(this.libraryRoot), LibraryStateSchema.parse(state))
    )
    // The chain survives a failed write; the caller still sees the rejection.
    this.writes = run.catch(() => undefined)
    return run
  }

  list(): IgnoredEntry[] {
    return [...this.entries].sort((a, b) => b.removedAt.localeCompare(a.removedAt))
  }

  isEmpty(): boolean {
    return this.entries.length === 0
  }

  /** Path match alone — cheap enough to ask about every file during a walk. */
  hasPath(relPath: string): boolean {
    return this.byPath.has(key(relPath))
  }

  /**
   * Fingerprint match, for a file that turned up somewhere else. Recording the
   * new path means the next walk catches it by path, before hashing.
   */
  async matchFingerprint(fingerprint: string, relPath: string): Promise<boolean> {
    const entry = this.byFingerprint.get(fingerprint)
    if (!entry) return false
    if (key(entry.path) !== key(relPath)) {
      entry.path = relPath
      this.reindex()
      await this.save()
    }
    return true
  }

  /** A companion file removed along with its entry; never regrouped, never regenerated. */
  hasCompanion(relPath: string): boolean {
    return this.companions.has(key(relPath))
  }

  async add(entry: IgnoredEntry): Promise<void> {
    await this.addMany([entry])
  }

  /**
   * Several entries in one write. Removing a folder puts every entry under it
   * on this list, and doing that one at a time rewrote the whole file once per
   * entry — hundreds of full-file writes for one click, each one a chance for a
   * virus scanner to be holding the file when the rename lands.
   */
  async addMany(entries: IgnoredEntry[]): Promise<void> {
    if (entries.length === 0) return
    const ids = new Set(entries.map((e) => e.id))
    const paths = new Set(entries.map((e) => key(e.path)))
    // Removing the same entry twice (or re-removing after a re-add) replaces
    // rather than accumulates, so the list stays a list of files, not of events.
    this.entries = this.entries.filter((e) => !ids.has(e.id) && !paths.has(key(e.path)))
    this.entries.push(...entries)
    this.reindex()
    await this.save()
  }

  /** Put one back: the next scan indexes it again from scratch. */
  async remove(id: string): Promise<boolean> {
    const before = this.entries.length
    this.entries = this.entries.filter((e) => e.id !== id)
    if (this.entries.length === before) return false
    this.reindex()
    await this.save()
    return true
  }

  async clear(): Promise<void> {
    this.entries = []
    this.reindex()
    await this.save()
  }
}
