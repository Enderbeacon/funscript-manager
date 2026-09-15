import { SCRIPT_AXIS_KEYS, type MediaMeta, type ScriptVersion } from '@shared/schemas/media-meta'
import { isMultiAxis } from './companion-grouping'

/**
 * "Single-axis borrows the other axes".
 *
 * A media often has one multi-axis script plus a few main-axis-only
 * alternatives. Playing an alternative usually should not silence roll/pitch/
 * … — most people want the alternative's stroke script with the multi-axis
 * version's remaining axes. So a single-axis version borrows every axis it
 * lacks from the media's default multi-axis version unless the user turns that
 * off per version (`inheritAxes: false`).
 *
 * Multi-axis versions borrow nothing: what they ship is what they mean.
 */

/** The multi-axis version a single-axis one borrows from: default, else first. */
export function axisDonor(meta: MediaMeta, version: ScriptVersion): ScriptVersion | null {
  const others = meta.scriptVersions.filter((v) => v.id !== version.id && isMultiAxis(v))
  return others.find((v) => v.isDefault) ?? others[0] ?? null
}

/** Does this version borrow, and is there anything to borrow from? */
export function inheritsAxes(meta: MediaMeta, version: ScriptVersion): boolean {
  if (isMultiAxis(version)) return false
  if (version.inheritAxes === false) return false
  return axisDonor(meta, version) !== null
}

/**
 * The axis → script-file map to actually play: the version's own files plus
 * the donor's other axes when borrowing. `main` is always the version's own.
 */
export function effectiveScriptFiles(
  meta: MediaMeta,
  version: ScriptVersion
): ScriptVersion['files'] {
  if (!inheritsAxes(meta, version)) return version.files
  const donor = axisDonor(meta, version)
  if (!donor) return version.files

  const files: Record<string, string> = { ...version.files }
  for (const axis of SCRIPT_AXIS_KEYS) {
    if (axis === 'main') continue
    const borrowed = donor.files[axis]
    if (borrowed !== undefined && files[axis] === undefined) files[axis] = borrowed
  }
  return files as ScriptVersion['files']
}

/** Axes borrowed from the donor (for the detail page's hint), in canonical order. */
export function borrowedAxes(meta: MediaMeta, version: ScriptVersion): string[] {
  if (!inheritsAxes(meta, version)) return []
  const own = version.files
  const effective = effectiveScriptFiles(meta, version)
  return SCRIPT_AXIS_KEYS.filter((a) => effective[a] !== undefined && own[a] === undefined)
}

/** Version names compare the way people read them, not byte for byte. */
function foldVersionName(name: string): string {
  return name.replace(/[\s._\-　]+/g, ' ').trim().toLowerCase()
}

/**
 * Two halves of one script set, filed separately: same version name, no axis in
 * common, and nobody claiming different authorship.
 *
 * `clip.authorA` (main) and `clip.authorA.roll` (roll) are that — one set that
 * arrived as two posts. Two scripters who both named their version after the
 * video are not, which is what the author test is for.
 */
function combinable(a: ScriptVersion, b: ScriptVersion): boolean {
  if (foldVersionName(a.name) !== foldVersionName(b.name)) return false
  if (a.author && b.author && a.author !== b.author) return false
  return !Object.keys(a.files).some((axis) => axis in b.files)
}

/**
 * Fold versions that are halves of one another together, left to right.
 *
 * The earliest keeps its id: the sidecar may already name it as the default or
 * the last used, and a merge is no reason for either to move. Input versions
 * are not mutated.
 */
export function combineAxes(versions: ScriptVersion[]): ScriptVersion[] {
  const out: ScriptVersion[] = []
  for (const version of versions) {
    const host = out.find((v) => combinable(v, version))
    if (!host) {
      out.push({ ...version, files: { ...version.files } })
      continue
    }
    Object.assign(host.files, version.files)
    if (!host.author && version.author) host.author = version.author
    if (!host.sourceUrl && version.sourceUrl) host.sourceUrl = version.sourceUrl
    if (!host.notes && version.notes) host.notes = version.notes
    // A version that now carries several axes has nothing left to borrow.
    delete host.inheritAxes
  }
  return out
}
