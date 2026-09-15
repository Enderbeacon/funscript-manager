import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { LIBRARY_CACHE_DIR } from '@shared/constants'
import type { ScriptVersion } from '@shared/schemas/media-meta'
import { mediaBasename } from '../library/companion-grouping'

/**
 * Playback session directory.
 *
 * MFP matches scripts by video basename across its configured script
 * libraries. The user registers `.fsmgr-cache/cache/playback/` there once;
 * before each playback we clear the directory and copy the chosen version's
 * scripts in under the video's basename (axis scripts with their suffix),
 * so MFP's automatic matching picks exactly the version the user chose.
 */

export function playbackSessionDir(libraryRoot: string): string {
  return join(libraryRoot, LIBRARY_CACHE_DIR, 'cache', 'playback')
}

/**
 * Reset the session dir and stage the version's scripts for a media file.
 * Passing no version just clears the dir (video without scripts).
 * Returns the staged file paths.
 */
export async function prepareSession(
  libraryRoot: string,
  mediaAbsPath: string,
  version: ScriptVersion | null
): Promise<string[]> {
  const dir = playbackSessionDir(libraryRoot)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  if (!version) return []

  const base = mediaBasename(basename(mediaAbsPath))
  const mediaDir = dirname(mediaAbsPath)
  const staged: string[] = []
  for (const [axis, rel] of Object.entries(version.files)) {
    if (!rel) continue
    // Script paths are sidecar-relative; reject anything escaping the library.
    const src = resolve(mediaDir, rel)
    const relToRoot = relative(libraryRoot, src)
    if (relToRoot.startsWith('..') || isAbsolute(relToRoot)) continue
    const target = join(dir, axis === 'main' ? `${base}.funscript` : `${base}.${axis}.funscript`)
    await copyFile(src, target)
    staged.push(target)
  }
  return staged
}

/** Current staged files (diagnostics). */
export async function listSession(libraryRoot: string): Promise<string[]> {
  try {
    return await readdir(playbackSessionDir(libraryRoot))
  } catch {
    return []
  }
}
