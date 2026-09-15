import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import {
  FUNSCRIPT_AXES,
  FUNSCRIPT_EXTENSION,
  type CompanionMatchLevel
} from '@shared/constants'
import type { MediaMeta, ScriptVersion } from '@shared/schemas/media-meta'
import { groupCompanions, isMediaFile, mediaBasename, parseFunscript } from './companion-grouping'
import { isSidecarFile, mediaPathForSidecar } from './sidecar'

/**
 * Companion files that turn up after their media was first indexed.
 *
 * Grouping used to run only at first ingest, which meant a script copied in
 * next to a video the library already knew about was invisible — and a script
 * with no video at all was invisible twice over. Both are how people actually
 * fill a library: the video comes from one place and the scripts from another,
 * minutes or days apart.
 *
 * Nothing here overrides a decision the user made. Versions are only ever
 * added, never renamed or removed, and a version's vacant axis is filled
 * rather than a second copy of it appended.
 */

function isFunscript(name: string): boolean {
  return name.toLowerCase().endsWith(FUNSCRIPT_EXTENSION)
}

/** Absolute paths of every companion file a sidecar already accounts for. */
function referencedFiles(meta: MediaMeta, mediaDir: string): Set<string> {
  const paths = meta.scriptVersions.flatMap((v) =>
    Object.values(v.files).filter((f): f is string => Boolean(f))
  )
  paths.push(...meta.subtitles.map((s) => s.path))
  return new Set(paths.map((p) => resolve(mediaDir, p).toLowerCase()))
}

/**
 * Fold companions found on disk into a sidecar, or return null when it already
 * has all of them.
 *
 * `siblingNames` is the whole directory listing, so the same ownership rules as
 * a first ingest apply: `movie.mp4` does not take `movie-2.funscript` when
 * `movie-2.mp4` is sitting right there.
 */
export function mergeLateCompanions(
  meta: MediaMeta,
  mediaName: string,
  mediaDir: string,
  siblingNames: string[],
  level: CompanionMatchLevel = 'exact'
): MediaMeta | null {
  const found = groupCompanions(mediaName, siblingNames, level)
  const referenced = referencedFiles(meta, mediaDir)
  const abs = (name: string): string => resolve(mediaDir, name).toLowerCase()

  const scriptVersions = [...meta.scriptVersions]
  let changed = false

  for (const version of found.scriptVersions) {
    // The schema guarantees a main axis; grouping only emits versions that have
    // one, so this is the one file every version can be identified by.
    const main = version.files.main
    if (!main) continue
    const mainAbs = abs(main)
    const existing = scriptVersions.find((v) => v.files.main && abs(v.files.main) === mainAbs)
    if (!existing) {
      scriptVersions.push({
        ...version,
        id: randomUUID(),
        // The library's existing default stays the default; a version that
        // arrived on its own does not get to take that over.
        ...(scriptVersions.length === 0 ? { isDefault: true } : { isDefault: false })
      })
      changed = true
      continue
    }
    // Same main script, extra axes: a multi-axis set whose other axes arrived
    // later belongs to the version that is already there.
    const files: Record<string, string> = { ...existing.files }
    let filled = false
    for (const axis of FUNSCRIPT_AXES) {
      const file = version.files[axis]
      if (!file || files[axis] || referenced.has(abs(file))) continue
      files[axis] = file
      filled = true
    }
    if (!filled) continue
    scriptVersions[scriptVersions.indexOf(existing)] = {
      ...existing,
      files: files as ScriptVersion['files']
    }
    changed = true
  }

  const subtitles = [...meta.subtitles]
  for (const subtitle of found.subtitles) {
    if (referenced.has(abs(subtitle.path))) continue
    subtitles.push(subtitle)
    changed = true
  }

  if (!changed) return null
  return { ...meta, scriptVersions, subtitles, updatedAt: new Date().toISOString() }
}

/** `clip.roll.funscript` → `clip`; `clip.funscript` → `clip`. */
export function scriptBaseName(fileName: string): string {
  const core = fileName.slice(0, fileName.length - FUNSCRIPT_EXTENSION.length)
  const axis = FUNSCRIPT_AXES.find((a) => core.toLowerCase().endsWith(`.${a}`))
  return axis ? core.slice(0, -(axis.length + 1)) : core
}

/**
 * Scripts in a directory that belong to no media file — and to no placeholder
 * either, which is what makes this safe to run on every scan: the entry created
 * for a set of scripts owns them from then on.
 *
 * Ownership is asked twice, and `isClaimed` is the authoritative half: a script
 * some sidecar already names belongs to that entry no matter what it is called.
 * The filename match is only for scripts nothing has filed yet — which is the
 * one case where the name is all there is to go on. Deciding by name alone was
 * the old rule, and it made renaming a media without its scripts impossible:
 * the scripts fell out of their owner's hands the moment the names diverged.
 *
 * Returns one group per would-be media file, in the order the names came in.
 */
export function orphanScriptGroups(
  siblingNames: string[],
  isClaimed: (fileName: string) => boolean = () => false,
  level: CompanionMatchLevel = 'exact'
): Map<string, string[]> {
  const owners = siblingNames
    .filter((n) => isMediaFile(n) || isSidecarFile(n))
    .map((n) => mediaBasename(isSidecarFile(n) ? mediaPathForSidecar(n) : n))

  const groups = new Map<string, string[]>()
  for (const name of siblingNames) {
    if (!isFunscript(name)) continue
    if (isClaimed(name)) continue
    if (owners.some((base) => parseFunscript(base, name, level) !== null)) continue
    const base = scriptBaseName(name)
    if (!base) continue
    groups.set(base, [...(groups.get(base) ?? []), name])
  }
  return groups
}
