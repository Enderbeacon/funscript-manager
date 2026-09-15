import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseFunscript } from '@shared/funscript'
import { renderHeatmapRgba } from '../services/heatmap/render'
import { encodePngRgba } from '../services/heatmap/png'
import { servePool } from '../util/worker-pool'

/**
 * Heatmap worker: funscript file → heatmap PNG on disk. Parse + render + encode happen off the main thread;
 * the PNG lands via `.tmp` + atomic rename like every other cache write.
 */

export interface HeatmapTask {
  scriptPath: string
  outPath: string
  width: number
  height: number
}

export interface HeatmapResult {
  /** false: script unreadable/unparseable/too short — nothing was written. */
  rendered: boolean
}

servePool<HeatmapTask, HeatmapResult>(async (task) => {
  let text: string
  try {
    text = await readFile(task.scriptPath, 'utf-8')
  } catch {
    return { rendered: false }
  }
  const script = parseFunscript(text)
  const pixels = script && renderHeatmapRgba(script.actions, task.width, task.height)
  if (!pixels) return { rendered: false }

  const png = encodePngRgba(pixels, task.width, task.height)
  await mkdir(dirname(task.outPath), { recursive: true })
  const tmp = `${task.outPath}.tmp`
  await writeFile(tmp, png)
  try {
    await rename(tmp, task.outPath)
  } catch (e) {
    await unlink(tmp).catch(() => {})
    throw e
  }
  return { rendered: true }
})
