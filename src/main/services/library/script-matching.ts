import { createHash } from 'node:crypto'
import { basename, resolve } from 'node:path'
import type { CompanionMatchLevel } from '@shared/constants'
import type { ScriptVersion } from '@shared/schemas/media-meta'
import type { ScriptMatchCandidate } from '@shared/schemas/script-match'
import { mediaBasename, parseFunscript, parseFunscriptFamily } from './companion-grouping'

export function scriptPathKey(path: string): string {
  return resolve(path).replaceAll('\\', '/').toLowerCase()
}

export interface ScriptMatchSource {
  id: string
  directory: string
  files: ScriptVersion['files']
  /** All script files of a placeholder, including its other versions. */
  paths: string[]
  mainNames: string[]
  sourceId?: string
  /** An existing main script is stronger evidence than another filename guess. */
  versionId?: string
  targetId?: string
  dismissed: string[]
  copy: boolean
}

export interface ScriptMatchMedia {
  mediaId: string
  filePath: string
  directory: string
}

export interface RankedScriptCandidate extends ScriptMatchCandidate {
  tier: number
  distance: number
  local: boolean
}

/** A family stays together: two folders' identically named axes never mix. */
export function scriptFamilies(directory: string, names: string[], copy: boolean): ScriptMatchSource[] {
  const families = new Map<string, { files: Partial<ScriptVersion['files']>; conflict: boolean }>()
  for (const name of [...names].sort()) {
    const parsed = parseFunscriptFamily(name)
    if (!parsed) continue
    const key = parsed.versionKey.toLowerCase()
    const family = families.get(key) ?? { files: {}, conflict: false }
    if (family.files[parsed.axis]) family.conflict = true
    family.files[parsed.axis] = name
    families.set(key, family)
  }
  const sources: ScriptMatchSource[] = []
  for (const { files, conflict } of families.values()) {
    if (!files.main || conflict) continue
    const paths = Object.values(files).map((file) => resolve(directory, file))
    sources.push({
      id: createHash('sha256').update(scriptPathKey(resolve(directory, files.main))).digest('hex'),
      directory,
      files: files as ScriptVersion['files'],
      paths,
      mainNames: [files.main],
      dismissed: [],
      copy
    })
  }
  return sources
}

function compare(a: RankedScriptCandidate, b: RankedScriptCandidate): number {
  return Number(b.local) - Number(a.local) || a.tier - b.tier || a.distance - b.distance
}

/** The same name rules as local grouping, with directory proximity as a preference. */
export function rankScriptCandidates(
  source: ScriptMatchSource,
  media: ScriptMatchMedia[],
  level: CompanionMatchLevel
): RankedScriptCandidate[] {
  const dismissed = new Set(source.dismissed)
  const candidates: RankedScriptCandidate[] = []
  for (const item of media) {
    if (source.targetId && item.mediaId !== source.targetId) continue
    if (dismissed.has(item.mediaId)) continue
    const base = mediaBasename(basename(item.filePath))
    let best: { tier: number; distance: number } | null = null
    for (const name of source.mainNames) {
      // Exact matching historically ignores case in the missing-video prompt.
      const match = mediaBasename(name).toLowerCase() === base.toLowerCase()
        ? { tier: 0, distance: 0 }
        : parseFunscript(base, name, level)
      if (match && (!best || match.tier < best.tier ||
        (match.tier === best.tier && match.distance < best.distance))) best = match
    }
    if (!best && source.targetId === item.mediaId) best = { tier: 0, distance: 0 }
    if (!best) continue
    candidates.push({
      mediaId: item.mediaId,
      filePath: item.filePath,
      kind: source.mainNames.every((name) => mediaBasename(name).toLowerCase() === base.toLowerCase())
        ? 'exact' : 'similar',
      tier: best.tier,
      distance: best.distance,
      local: scriptPathKey(source.directory) === scriptPathKey(item.directory)
    })
  }
  return candidates.sort((a, b) => compare(a, b) || a.filePath.localeCompare(b.filePath))
}

export function suggestedScriptTarget(candidates: RankedScriptCandidate[]): string | null {
  const first = candidates[0]
  return first && (!candidates[1] || compare(first, candidates[1]) < 0) ? first.mediaId : null
}

/** Auto-link only a unique identical name across the entire library. */
export function automaticScriptTarget(source: ScriptMatchSource, candidates: RankedScriptCandidate[]): string | null {
  if (source.copy) return null
  if (source.versionId && source.targetId && candidates.some((candidate) => candidate.mediaId === source.targetId)) {
    return source.targetId
  }
  const exact = candidates.filter((candidate) => candidate.kind === 'exact')
  return exact.length === 1 ? exact[0]!.mediaId : null
}
