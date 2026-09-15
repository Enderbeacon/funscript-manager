import { readFile, stat } from 'node:fs/promises'
import { cpus } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { LIBRARY_CACHE_DIR } from '@shared/constants'
import type { MediaMeta, ScriptVersion } from '@shared/schemas/media-meta'
import { WorkerPool } from '../../util/worker-pool'
import { readSidecar, sidecarPathFor } from '../library/sidecar'
import type { HeatmapTask, HeatmapResult } from '../../workers/heatmap.worker'
import heatmapWorkerPath from '../../workers/heatmap.worker?modulePath'

/**
 * Heatmap cache service: `<root>/.fsmgr-cache/cache/heatmaps/<mediaId>.<versionId>.png`
 * (disposable, rebuilt on demand). Freshness is
 * mtime-based: a cached PNG is valid while it is newer than its script file.
 * Rendering runs in the heatmap worker pool; concurrent requests for the
 * same PNG are coalesced.
 */

const HEATMAP_WIDTH = 600
const HEATMAP_HEIGHT = 56
const POOL_SIZE = Math.min(2, Math.max(1, cpus().length - 1))

let pool: WorkerPool<HeatmapTask, HeatmapResult> | null = null

const inflight = new Map<string, Promise<string | null>>()

function pickVersion(meta: MediaMeta, versionId?: string): ScriptVersion | null {
  if (versionId) return meta.scriptVersions.find((v) => v.id === versionId) ?? null
  return meta.scriptVersions.find((v) => v.isDefault) ?? meta.scriptVersions[0] ?? null
}

/**
 * Get (rendering if stale/missing) the heatmap for a media item's script
 * version — the default version when none is given — as a PNG data URL.
 * Null: no scripts, script file gone, or unparseable.
 */
export async function getHeatmapDataUrl(opts: {
  libraryRoot: string
  mediaId: string
  /** Media path relative to the library root (index.db `file_path`). */
  mediaRelPath: string
  scriptVersionId?: string
}): Promise<string | null> {
  const mediaAbs = join(opts.libraryRoot, opts.mediaRelPath)
  const sidecar = await readSidecar(sidecarPathFor(mediaAbs))
  if (!sidecar.ok) return null
  const version = pickVersion(sidecar.meta, opts.scriptVersionId)
  const mainRel = version?.files.main
  if (!version || !mainRel) return null

  // Script paths are sidecar-relative; reject anything escaping the library.
  const scriptPath = resolve(dirname(mediaAbs), mainRel)
  const relToRoot = relative(opts.libraryRoot, scriptPath)
  if (relToRoot.startsWith('..') || isAbsolute(relToRoot)) return null

  const cachePath = join(
    opts.libraryRoot,
    LIBRARY_CACHE_DIR,
    'cache',
    'heatmaps',
    `${opts.mediaId}.${version.id}.png`
  )

  const running = inflight.get(cachePath)
  if (running) return running
  const task = produce(scriptPath, cachePath).finally(() => inflight.delete(cachePath))
  inflight.set(cachePath, task)
  return task
}

async function produce(scriptPath: string, cachePath: string): Promise<string | null> {
  let scriptStat
  try {
    scriptStat = await stat(scriptPath)
  } catch {
    return null // script file missing
  }

  try {
    const cached = await stat(cachePath)
    if (cached.mtimeMs >= scriptStat.mtimeMs) return toDataUrl(await readFile(cachePath))
  } catch {
    // cache miss — render below
  }

  pool ??= new WorkerPool(heatmapWorkerPath, POOL_SIZE, 'heatmap')
  try {
    const result = await pool.run({
      scriptPath,
      outPath: cachePath,
      width: HEATMAP_WIDTH,
      height: HEATMAP_HEIGHT
    })
    if (!result.rendered) return null
    return toDataUrl(await readFile(cachePath))
  } catch (e) {
    console.error(`[heatmap] render failed for ${scriptPath}:`, e)
    return null
  }
}

function toDataUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`
}

/** Terminate all workers (app shutdown). */
export async function disposeHeatmapPool(): Promise<void> {
  const p = pool
  pool = null
  await p?.dispose()
}
