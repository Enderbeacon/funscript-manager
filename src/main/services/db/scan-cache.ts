import type Database from 'better-sqlite3'
import { funscriptAxisFromToken, type FunscriptAxis } from '@shared/constants'
import { MediaMetaSchema, type MediaMeta } from '@shared/schemas/media-meta'

/** Additive, disposable scan snapshots; older builds can ignore these tables. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS scan_directory (
  path TEXT PRIMARY KEY, stamp TEXT NOT NULL, observed_at INTEGER NOT NULL, entries TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scan_sidecar (
  path TEXT PRIMARY KEY, stamp TEXT NOT NULL, meta TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scan_script_axes (
  path TEXT PRIMARY KEY, stamp TEXT NOT NULL, axes TEXT NOT NULL
);`

export interface DirectoryEntry {
  name: string
  kind: 'file' | 'directory' | 'other'
}

export interface DirectorySnapshot {
  stamp: string
  observedAt: number
  entries: DirectoryEntry[]
}

export function sidecarStamp(info: { mtimeMs: number; ctimeMs: number; size: number }): string {
  return `${info.mtimeMs}:${info.ctimeMs}:${info.size}`
}

export class LibraryScanCache {
  private directories = new Map<string, DirectorySnapshot>()
  private sidecars = new Map<string, { stamp: string; meta: MediaMeta }>()
  private loadedSidecars = new Map<string, { stamp: string; meta: MediaMeta }>()
  private invalidDirectories = new Set<string>()
  private scripts = new Map<string, { stamp: string; axes: FunscriptAxis[] }>()
  force = false
  counters = { directoriesRead: 0, directoriesReused: 0, sidecarsRead: 0, sidecarsReused: 0 }

  constructor(private readonly db: Database.Database) {
    db.exec(SCHEMA)
  }

  begin(force: boolean): void {
    this.force = force
    this.counters = { directoriesRead: 0, directoriesReused: 0, sidecarsRead: 0, sidecarsReused: 0 }
  }

  directory(path: string): DirectorySnapshot | null {
    if (this.force || this.invalidDirectories.has(path)) return null
    const pending = this.directories.get(path)
    if (pending) return pending
    const row = this.db.prepare('SELECT stamp, observed_at, entries FROM scan_directory WHERE path = ?')
      .get(path) as { stamp: string; observed_at: number; entries: string } | undefined
    if (!row) return null
    try {
      const entries: unknown = JSON.parse(row.entries)
      if (!Array.isArray(entries) || entries.some((entry) => !entry || typeof entry.name !== 'string' ||
        !entry.name || entry.name === '.' || entry.name === '..' || /[\\/]/.test(entry.name) ||
        !['file', 'directory', 'other'].includes(entry.kind))) return null
      return { stamp: row.stamp, observedAt: row.observed_at, entries }
    } catch { return null }
  }

  setDirectory(path: string, snapshot: DirectorySnapshot): void {
    this.invalidDirectories.delete(path)
    this.directories.set(path, snapshot)
  }

  invalidateDirectory(path: string): void {
    this.directories.delete(path)
    this.invalidDirectories.add(path)
  }

  sidecar(path: string, stamp: string): MediaMeta | null {
    if (this.force) return null
    const pending = this.sidecars.get(path)
    if (pending?.stamp === stamp) return pending.meta
    const loaded = this.loadedSidecars.get(path)
    if (loaded?.stamp === stamp) return loaded.meta
    const row = this.db.prepare('SELECT stamp, meta FROM scan_sidecar WHERE path = ?').get(path) as
      { stamp: string; meta: string } | undefined
    if (!row || row.stamp !== stamp) return null
    try {
      const parsed = MediaMetaSchema.safeParse(JSON.parse(row.meta))
      if (!parsed.success) return null
      this.loadedSidecars.set(path, { stamp, meta: parsed.data })
      return parsed.data
    } catch { return null }
  }

  setSidecar(path: string, stamp: string, meta: MediaMeta): void {
    this.sidecars.set(path, { stamp, meta })
    this.loadedSidecars.set(path, { stamp, meta })
  }

  scriptAxes(path: string, stamp: string): FunscriptAxis[] | null {
    const pending = this.scripts.get(path)
    if (pending?.stamp === stamp) return pending.axes
    if (this.force) return null
    const row = this.db.prepare('SELECT stamp, axes FROM scan_script_axes WHERE path = ?').get(path) as
      { stamp: string; axes: string } | undefined
    if (!row || row.stamp !== stamp) return null
    try {
      const axes: unknown = JSON.parse(row.axes)
      if (!Array.isArray(axes) || axes.some((axis) => typeof axis !== 'string' || funscriptAxisFromToken(axis) !== axis)) return null
      return axes as FunscriptAxis[]
    } catch { return null }
  }

  setScriptAxes(path: string, stamp: string, axes: FunscriptAxis[]): void {
    this.scripts.set(path, { stamp, axes })
  }

  /** One transaction rather than one external-drive fsync per directory or JSON file. */
  flush(): void {
    this.force = false
    this.loadedSidecars.clear()
    if (!this.directories.size && !this.sidecars.size && !this.invalidDirectories.size && !this.scripts.size) return
    this.db.transaction(() => {
      const drop = this.db.prepare('DELETE FROM scan_directory WHERE path = ?')
      for (const path of this.invalidDirectories) drop.run(path)
      const dir = this.db.prepare('INSERT OR REPLACE INTO scan_directory VALUES (?, ?, ?, ?)')
      for (const [path, row] of this.directories) dir.run(path, row.stamp, row.observedAt, JSON.stringify(row.entries))
      const sidecar = this.db.prepare('INSERT OR REPLACE INTO scan_sidecar VALUES (?, ?, ?)')
      for (const [path, row] of this.sidecars) sidecar.run(path, row.stamp, JSON.stringify(row.meta))
      const script = this.db.prepare('INSERT OR REPLACE INTO scan_script_axes VALUES (?, ?, ?)')
      for (const [path, row] of this.scripts) script.run(path, row.stamp, JSON.stringify(row.axes))
    })()
    this.directories.clear()
    this.sidecars.clear()
    this.scripts.clear()
    this.invalidDirectories.clear()
  }
}
