import { randomUUID } from 'node:crypto'
import {
  AUDIO_EXTENSIONS,
  COMPANION_MATCH_LEVELS,
  FUNSCRIPT_AXES,
  FUNSCRIPT_EXTENSION,
  SUBTITLE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  type CompanionMatchLevel,
  type FunscriptAxis
} from '@shared/constants'
import type { ScriptVersion, Subtitle } from '@shared/schemas/media-meta'

/**
 * Companion-file grouping heuristics: which scripts and subtitles next to a
 * media file belong to it, and as which version and axis.
 *
 * Pure functions over filenames only (no I/O), so they are easy to reason
 * about and test. All paths produced are plain filenames, i.e. relative to
 * the media file's own directory (which is also the sidecar's directory).
 */

const AXIS_SET = new Set<string>(FUNSCRIPT_AXES)

export function isVideoFile(name: string): boolean {
  return VIDEO_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext))
}

export function isAudioFile(name: string): boolean {
  return AUDIO_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext))
}

export function isMediaFile(name: string): boolean {
  return isVideoFile(name) || isAudioFile(name)
}

/** Filename without its (media) extension: `video.mp4` → `video`, `a.1080p.mkv` → `a.1080p`. */
export function mediaBasename(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? name : name.slice(0, dot)
}

/**
 * Each level is only consulted when the tighter ones found nothing, so widening
 * it can rescue a script but never re-decide one a stricter rule already placed.
 *
 * Measured over a real 2000-script library: `separators` and `affixes` place
 * scripts the strict rule drops without ever disagreeing with it; `loose` picks
 * a different video for about one script in twenty-five, which is why it is not
 * the default.
 */
const rank = (level: CompanionMatchLevel): number => COMPANION_MATCH_LEVELS.indexOf(level)

/** Boundaries a variant label may open with, once the media's name has ended. */
const STRICT_BOUNDARY = /^[._-]/
const WIDE_BOUNDARY = /^[._\-\s([{【（〔]/

/** Lower-cased, with every run of separators reduced to one space. */
function fold(value: string): string {
  return value.replace(/[\s._\-　]+/g, ' ').trim().toLowerCase()
}

export interface NameMatch {
  /**
   * The part of the companion's name the media's name does not account for —
   * the variant label, wherever it sat.
   */
  leftover: string
  /**
   * Which level found it. A media that matches at a tighter level beats one
   * that only matches at a looser one, whatever the leftovers say: two videos
   * whose names differ solely in separators both "match" a script equally once
   * folded, and without this the exact one would lose its own script to a tie.
   */
  tier: number
  /** How much text the two names do not share; among equal tiers, least wins. */
  distance: number
}

/** Is `a` the better claim? Equal on both counts means nobody may claim. */
function betterClaim(a: NameMatch, b: NameMatch): boolean {
  return a.tier !== b.tier ? a.tier < b.tier : a.distance < b.distance
}

function sameClaim(a: NameMatch, b: NameMatch): boolean {
  return a.tier === b.tier && a.distance === b.distance
}

/**
 * Largest `i` with `fold(core.slice(0, i)) === folded`, so a folded match can
 * still report a leftover in the user's own spelling.
 */
function foldedPrefixEnd(core: string, folded: string): number | null {
  for (let i = core.length; i >= 0; i--) {
    if (fold(core.slice(0, i)) === folded) return i
  }
  return null
}

/** Smallest `i` with `fold(core.slice(i)) === folded`. */
function foldedSuffixStart(core: string, folded: string): number | null {
  for (let i = 0; i <= core.length; i++) {
    if (fold(core.slice(i)) === folded) return i
  }
  return null
}

/**
 * Does `core` (a companion filename without its extension) belong to the media
 * called `basename`, and what is left over if so?
 *
 * The levels, in the order they are tried:
 *   exact       `clip` + `.`/`_`/`-`      — `clip.roll`, `clip_authorA`
 *   separators  any separator or bracket  — `clip (Soft)`, `clip[0-100]`,
 *               and separators/case folded — `My_Clip` for `My Clip.mp4`
 *   affixes     the label may lead        — `(NO FILLER) clip` for `clip.mp4`,
 *               or the media may carry it — `clip` for `[Author] clip.mp4`
 *   loose       either name inside the other, on whole words
 */
export function matchCompanion(
  basename: string,
  core: string,
  level: CompanionMatchLevel = 'exact'
): NameMatch | null {
  const allowed = rank(level)

  if (core.startsWith(basename)) {
    const rest = core.slice(basename.length)
    if (rest === '' || STRICT_BOUNDARY.test(rest)) {
      return { leftover: rest, tier: 0, distance: fold(rest).length }
    }
    if (allowed >= rank('separators') && WIDE_BOUNDARY.test(rest)) {
      return { leftover: rest, tier: 1, distance: fold(rest).length }
    }
  }
  if (allowed < rank('separators')) return null

  const foldedBase = fold(basename)
  const foldedCore = fold(core)
  if (!foldedBase || !foldedCore) return null

  // Separators and case folded away: `My_Clip.funscript` for `My Clip.mp4`.
  if (foldedCore === foldedBase || foldedCore.startsWith(foldedBase + ' ')) {
    const end = foldedPrefixEnd(core, foldedBase)
    if (end !== null) {
      const rest = core.slice(end)
      return { leftover: rest, tier: 2, distance: fold(rest).length }
    }
  }
  if (allowed < rank('affixes')) return null

  // The label leads instead of trails. Guarded against a name so short that it
  // would ride along on any long title that happens to end with it.
  const substantial = foldedCore.length >= 4 && !/^\d+$/.test(foldedCore)
  if (substantial && foldedCore.endsWith(' ' + foldedBase)) {
    const start = foldedSuffixStart(core, foldedBase)
    if (start !== null) {
      const rest = core.slice(0, start)
      return { leftover: rest, tier: 3, distance: fold(rest).length }
    }
  }
  // The media carries the extra label: `clip.funscript` beside `[Author] clip.mp4`.
  if (foldedBase.endsWith(' ' + foldedCore) && foldedCore.length >= 4) {
    return { leftover: '', tier: 3, distance: foldedBase.length - foldedCore.length }
  }
  if (allowed < rank('loose')) return null

  const padBase = ` ${foldedBase} `
  const padCore = ` ${foldedCore} `
  if (padCore.includes(padBase) || padBase.includes(padCore)) {
    return { leftover: '', tier: 4, distance: Math.abs(foldedCore.length - foldedBase.length) }
  }
  return null
}

interface ParsedFunscript extends NameMatch {
  versionKey: string
  axis: FunscriptAxis
}

/**
 * Parse a funscript filename against a media basename. The axis token may
 * sit anywhere among the dot-segments (real-world names put variant labels
 * after the axis); the remaining segments form the version key.
 * `video.funscript`              → { versionKey: '',           axis: 'main' }
 * `video.roll.funscript`         → { versionKey: '',           axis: 'roll' }
 * `video_authorA.roll.funscript` → { versionKey: 'authorA',    axis: 'roll' }
 * `video-remix2.funscript`       → { versionKey: 'remix2',     axis: 'main' }
 * `video.roll.valve.funscript`   → { versionKey: 'valve',      axis: 'roll' }
 */
export function parseFunscript(
  basename: string,
  filename: string,
  level: CompanionMatchLevel = 'exact'
): ParsedFunscript | null {
  const lower = filename.toLowerCase()
  if (!lower.endsWith(FUNSCRIPT_EXTENSION)) return null
  const core = filename.slice(0, filename.length - FUNSCRIPT_EXTENSION.length)

  const direct = matchCompanion(basename, core, level)
  if (direct) return { ...direct, ...keyed(basename, core, direct.leftover, splitAxis(direct.leftover)) }

  // A trailing axis has to come off before the name can be read from its end:
  // `(NO FILLER) clip.roll` is `(NO FILLER) clip` plus roll, and nothing in
  // `…clip.roll` ends with `clip`.
  const trailing = trailingAxis(core)
  if (!trailing) return null
  const match = matchCompanion(basename, trailing.core, level)
  if (!match) return null
  return {
    ...match,
    ...keyed(basename, trailing.core, match.leftover, {
      versionKey: labelOf(match.leftover),
      axis: trailing.axis
    })
  }
}

/**
 * Two scripts must never share a version key unless they really are the same
 * version. The looser levels can match with nothing left over at all — `clip`
 * found inside `SLR_clip_4320p` leaves no label — and two of those would land
 * on one key and overwrite each other's main axis. Falling back to the script's
 * own name keeps them apart, and it is the only name there is to call it by.
 *
 * Keyed off the leftover rather than the version key, because an empty version
 * key is also what a plain `clip.roll.funscript` produces, and that one must
 * stay on the default version where its main axis is.
 */
function keyed(
  basename: string,
  core: string,
  leftover: string,
  parsed: { versionKey: string; axis: FunscriptAxis }
): { versionKey: string; axis: FunscriptAxis } {
  if (leftover !== '' || fold(core) === fold(basename)) return parsed
  return { ...parsed, versionKey: core }
}

/** `clip.roll` → { core: 'clip', axis: 'roll' }; nothing when it ends plainly. */
function trailingAxis(core: string): { core: string; axis: FunscriptAxis } | null {
  const dot = core.lastIndexOf('.')
  if (dot === -1) return null
  const tail = core.slice(dot + 1).toLowerCase()
  return AXIS_SET.has(tail) ? { core: core.slice(0, dot), axis: tail as FunscriptAxis } : null
}

/** The leftover as a version label: separators trimmed off either end. */
function labelOf(leftover: string): string {
  return leftover.replace(/^[._\-\s([{【（〔]+/, '').replace(/[\s._-]+$/, '')
}

/**
 * Pull the axis out of a leftover, wherever it sits among the dot-segments —
 * real-world names put the variant label after the axis — and return what
 * remains as the version key.
 */
function splitAxis(leftover: string): { versionKey: string; axis: FunscriptAxis } {
  const stripped = labelOf(leftover)
  const segments = stripped === '' ? [] : stripped.split('.')
  // Last known-axis segment wins (axis-at-end is the common convention).
  let axis: FunscriptAxis = 'main'
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!.toLowerCase()
    if (AXIS_SET.has(seg)) {
      axis = seg as FunscriptAxis
      segments.splice(i, 1)
      break
    }
  }
  return { versionKey: segments.join('.'), axis }
}

/**
 * Which of `mediaNames` owns `scriptName` — the claim rule `groupCompanions`
 * uses among siblings, hoisted so callers that hold a set of files without
 * scanning a directory (post-download ingest) can ask the same question.
 *
 * Null when no name matches, and null on a dead heat: two media with an equal
 * claim leave the script to neither, rather than to whichever came first.
 */
export function scriptOwner(
  mediaNames: string[],
  scriptName: string,
  level: CompanionMatchLevel = 'exact'
): string | null {
  let winner: string | null = null
  let best: NameMatch | null = null
  let tied = false
  for (const media of mediaNames) {
    const claim = parseFunscript(mediaBasename(media), scriptName, level)
    if (!claim) continue
    if (!best || betterClaim(claim, best)) {
      best = claim
      winner = media
      tied = false
    } else if (sameClaim(claim, best)) {
      tied = true
    }
  }
  return tied ? null : winner
}

interface ParsedSubtitle extends NameMatch {
  language?: string
}

/**
 * `video.srt` → {}; `video.en.srt` → { language: 'en' };
 * `video.zh-CN.srt` → { language: 'zh-CN' }.
 */
export function parseSubtitle(
  basename: string,
  filename: string,
  level: CompanionMatchLevel = 'exact'
): ParsedSubtitle | null {
  const lower = filename.toLowerCase()
  const ext = SUBTITLE_EXTENSIONS.find((e) => lower.endsWith(e))
  if (!ext) return null
  const core = filename.slice(0, filename.length - ext.length)
  const match = matchCompanion(basename, core, level)
  if (!match) return null
  const lang = labelOf(match.leftover)
  return lang === '' ? match : { ...match, language: lang }
}

export interface GroupedCompanions {
  scriptVersions: ScriptVersion[]
  subtitles: Subtitle[]
}

/**
 * Group all sibling filenames into script versions and subtitles for the
 * media file identified by `mediaName`. `siblingNames` are the filenames in
 * the same directory (including the media file itself, which is ignored).
 *
 * Ownership: when several sibling media basenames match a companion (e.g.
 * `movie.mp4` and `movie-2.mp4` both matching `movie-2.funscript`), the
 * longest matching basename owns it — only that media lists the file.
 */
export function groupCompanions(
  mediaName: string,
  siblingNames: string[],
  level: CompanionMatchLevel = 'exact'
): GroupedCompanions {
  const basename = mediaBasename(mediaName)
  const otherMediaBases = siblingNames
    .filter((n) => n !== mediaName && isMediaFile(n))
    .map(mediaBasename)

  /**
   * Whoever has the better claim owns it: a tighter level first, then the least
   * left unaccounted for. That is the old "longest basename wins" generalised —
   * under a prefix match the longest name does leave the least over — and it
   * keeps a video that matches outright from losing its own script to one that
   * only matches once separators are folded away.
   *
   * A dead heat is not broken. Two videos with an identical claim leave the
   * script to neither, and it becomes an entry of its own rather than a guess.
   */
  const claimedElsewhere = (name: string, mine: NameMatch, isScript: boolean): boolean =>
    otherMediaBases.some((other) => {
      const theirs = isScript
        ? parseFunscript(other, name, level)
        : parseSubtitle(other, name, level)
      return theirs !== null && (betterClaim(theirs, mine) || sameClaim(theirs, mine))
    })

  // versionKey → axis → filename
  const versions = new Map<string, Partial<Record<FunscriptAxis, string>>>()
  const subtitles: Subtitle[] = []

  for (const name of siblingNames) {
    if (name === mediaName) continue

    const fs = parseFunscript(basename, name, level)
    if (fs) {
      if (claimedElsewhere(name, fs, true)) continue
      const axes = versions.get(fs.versionKey) ?? {}
      axes[fs.axis] = name
      versions.set(fs.versionKey, axes)
      continue
    }

    const sub = parseSubtitle(basename, name, level)
    if (sub && !claimedElsewhere(name, sub, false)) {
      subtitles.push({ path: name, ...(sub.language ? { language: sub.language } : {}) })
    }
  }

  // A version key with axes but no main (e.g. `video.roll.valve.funscript`
  // alone) cannot stand as a version. Donate its axis files to the default
  // version's vacant axes instead of silently dropping usable scripts.
  const defaultFiles = versions.get('')
  if (defaultFiles?.main !== undefined) {
    for (const key of [...versions.keys()].sort()) {
      const files = versions.get(key)!
      if (key === '' || files.main !== undefined) continue
      for (const [axis, file] of Object.entries(files) as [FunscriptAxis, string][]) {
        defaultFiles[axis] ??= file
      }
      versions.delete(key)
    }
  }

  const scriptVersions: ScriptVersion[] = []
  // '' (default) version sorts first, so it becomes the default pick.
  const keys = [...versions.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))

  for (const key of keys) {
    const files = versions.get(key)!
    if (files.main === undefined) continue // schema requires a main axis; skip axis-only groups

    scriptVersions.push({
      id: randomUUID(),
      name: key === '' ? scriptVersionName(files.main) : key,
      ...(key ? { author: key } : {}),
      isDefault: scriptVersions.length === 0,
      files: files as ScriptVersion['files']
    })
  }

  return { scriptVersions, subtitles }
}

/**
 * What to call a version whose file name carried no variant label — the script
 * that shares the media's own name.
 *
 * Its own name, minus the extension. The alternative was the literal word
 * "Default", which in a library where nearly every entry has one is a column of
 * the same word saying nothing about which file is playing.
 */
export function scriptVersionName(mainFile: string): string {
  const name = mainFile.split(/[\\/]/).pop() ?? mainFile
  const cut = name.toLowerCase().lastIndexOf(FUNSCRIPT_EXTENSION)
  return cut > 0 ? name.slice(0, cut) : name
}

/** A script version is multi-axis if it carries any non-main axis file. */
export function isMultiAxis(version: ScriptVersion): boolean {
  return Object.keys(version.files).some((k) => k !== 'main')
}
