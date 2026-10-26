import { readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import type { FunscriptAxis } from '@shared/constants'
import { parseFunscriptAxes } from '@shared/funscript'
import { SCRIPT_AXIS_KEYS, type MediaMeta } from '@shared/schemas/media-meta'
import { sidecarStamp, type LibraryScanCache } from '../db/scan-cache'

/** Discover embedded tracks without creating files beside the user's scripts. */
export class MergedScriptDiscovery {
  private pending = new Map<string, Promise<FunscriptAxis[] | null>>()

  constructor(private readonly root: string, private readonly cache?: LibraryScanCache) {}

  private async axes(path: string): Promise<FunscriptAxis[] | null> {
    const rel = relative(this.root, path)
    if (rel.startsWith('..') || isAbsolute(rel)) return null
    try {
      const info = await stat(path)
      const stamp = sidecarStamp(info)
      const cached = this.cache?.scriptAxes(path, stamp)
      if (cached) return cached
      const key = `${path}:${stamp}`
      let pending = this.pending.get(key)
      if (!pending) {
        pending = readFile(path, 'utf8').then((text) => {
          const axes = Object.keys(parseFunscriptAxes(text)) as FunscriptAxis[]
          this.cache?.setScriptAxes(path, stamp, axes)
          return axes
        }).catch(() => null).finally(() => this.pending.delete(key))
        this.pending.set(key, pending)
      }
      return await pending
    } catch { return null }
  }

  /** Update the caller's metadata before writing/indexing; true means axes changed. */
  async discover(mediaAbs: string, meta: MediaMeta): Promise<boolean> {
    let changed = false
    const versions = await Promise.all(meta.scriptVersions.map(async (version) => {
      const main = version.files.main
      // A remapped primary track is an explicit assignment, not a new container.
      if (!main || (version.fileAxes?.main && version.fileAxes.main !== 'main')) return version
      const available = await this.axes(resolve(dirname(mediaAbs), main))
      if (!available) return version
      const files = { ...version.files }
      const fileAxes = { ...version.fileAxes }
      for (const axis of SCRIPT_AXIS_KEYS) {
        if (axis !== 'main' && files[axis] === main && fileAxes[axis] && !available.includes(fileAxes[axis]!)) {
          delete files[axis]
          delete fileAxes[axis]
        }
      }
      if (available.some((axis) => axis !== 'main')) {
        fileAxes.main ??= 'main'
        for (const axis of available) {
          if (axis === 'main' || files[axis]) continue
          // An axis already moved to another destination must stay there.
          if (SCRIPT_AXIS_KEYS.some((dest) => files[dest] === main && fileAxes[dest] === axis)) continue
          files[axis] = main
          fileAxes[axis] = axis
        }
      }
      if (JSON.stringify(files) === JSON.stringify(version.files) &&
          JSON.stringify(fileAxes) === JSON.stringify(version.fileAxes ?? {})) return version
      changed = true
      return { ...version, files, fileAxes }
    }))
    if (changed) meta.scriptVersions = versions
    return changed
  }
}
