import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  LEGACY_LIBRARY_STATE_JSON,
  LIBRARY_DATA_DIR,
  LIBRARY_STATE_JSON
} from '@shared/constants'
import {
  LibraryStateSchema,
  type IgnoredEntry,
  type LibraryState,
  type MetaState
} from '@shared/schemas/library-state'
import { atomicWriteJson, readJsonOr } from '../../util/atomic-json'
import { setAsideUnreadable, withUnknownKeys } from '../../util/persisted'

/**
 * `<library root>/.fsmgr/state.json`, held in memory per library and written
 * through on every change (see LibraryStateSchema for what it holds).
 *
 * Several parts of the app own a piece of it — the ignore list, the sidecar
 * location — and each writes only its own piece. They share one object so
 * that neither can write back a stale copy of the other's.
 */

export function libraryDataDir(libraryRoot: string): string {
  return join(libraryRoot, LIBRARY_DATA_DIR)
}

function statePath(libraryRoot: string): string {
  return join(libraryDataDir(libraryRoot), LIBRARY_STATE_JSON)
}

function legacyStatePath(libraryRoot: string): string {
  return join(libraryRoot, LEGACY_LIBRARY_STATE_JSON)
}

export class LibraryStateFile {
  // One write at a time, so a slow one cannot land on top of a newer one.
  private writes: Promise<unknown> = Promise.resolve()

  private constructor(
    private readonly libraryRoot: string,
    private state: LibraryState,
    /** The file as read, so fields from a newer build are written back unchanged. */
    private raw: unknown
  ) {}

  /**
   * Read the state, moving it out of the library root first if it is still in
   * the file it used to live in.
   *
   * A file that does not validate is moved aside rather than written over — it
   * is the only copy of decisions the user made — and the library opens with
   * an empty state rather than not at all.
   */
  static async load(libraryRoot: string): Promise<LibraryStateFile> {
    const path = statePath(libraryRoot)
    let raw = await readJsonOr(path, null)
    let fromLegacy = false
    if (raw === null) {
      raw = await readJsonOr(legacyStatePath(libraryRoot), null)
      fromLegacy = raw !== null
    }
    if (raw === null) {
      return new LibraryStateFile(libraryRoot, LibraryStateSchema.parse({ schemaVersion: 1 }), {})
    }
    const parsed = LibraryStateSchema.safeParse(raw)
    if (!parsed.success) {
      console.warn(`[library] state for ${libraryRoot} did not validate:`, parsed.error.issues)
      await setAsideUnreadable(fromLegacy ? legacyStatePath(libraryRoot) : path)
      return new LibraryStateFile(libraryRoot, LibraryStateSchema.parse({ schemaVersion: 1 }), {})
    }
    const file = new LibraryStateFile(libraryRoot, parsed.data, raw)
    if (fromLegacy) {
      // The new file first: until it is written, the old one is the only copy.
      await file.save()
      await rm(legacyStatePath(libraryRoot), { force: true })
    }
    return file
  }

  get ignored(): IgnoredEntry[] {
    return this.state.ignored
  }

  /** Undefined until the library has had a location recorded. */
  get metadata(): MetaState | undefined {
    return this.state.metadata
  }

  async setIgnored(ignored: IgnoredEntry[]): Promise<void> {
    this.state = { ...this.state, ignored }
    await this.save()
  }

  async setMetadata(metadata: MetaState): Promise<void> {
    this.state = { ...this.state, metadata }
    await this.save()
  }

  private save(): Promise<void> {
    const snapshot = withUnknownKeys(LibraryStateSchema.parse(this.state), this.raw)
    const run = this.writes.then(() => atomicWriteJson(statePath(this.libraryRoot), snapshot))
    // The chain survives a failed write; the caller still sees the rejection.
    this.writes = run.catch(() => undefined)
    return run
  }
}
