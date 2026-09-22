import { AppError } from '@shared/errors'
import type { MediaDetail } from '@shared/schemas/media-index'
import { NAME_FIELDS, type MediaMeta, type NameField } from '@shared/schemas/media-meta'
import type { EntityKind } from '@shared/schemas/taxonomy'
import type { VrFormat } from '@shared/schemas/vr-video'
import { normaliseNames } from '../taxonomy/taxonomy-service'
import { editMedia, listStartedLibraries, type MediaEditor } from './library-manager'

/**
 * Editing the names and marks a media carries.
 *
 * Everything here goes through the sidecar — the index is refreshed as a
 * consequence, never edited directly. Three rules the whole file follows:
 *
 * - **Names are canonicalised on the way in.** Typing an alias stores the real
 *   name, so `Virtual Reality` from a forum post and `VR` from the user are
 *   one thing rather than two that look alike.
 * - **New names create entities.** Naming something the taxonomy has not heard
 *   of is how a vocabulary grows; it is not an error to be reported.
 * - **Batch edits are additive by default.** Add and remove are separate
 *   operations, because "set these tags on 40 media" almost always means "add"
 *   and silently dropping the other 39 tags is unrecoverable.
 */

export interface MediaTarget {
  libraryId: string
  mediaId: string
}

function dedupe(names: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of names) {
    const trimmed = name.trim()
    if (!trimmed) continue
    const key = trimmed.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(trimmed)
  }
  return out
}

/** Canonicalise, dedupe, and register anything new (taxonomy-service owns it). */
const normalise = normaliseNames

/** Replace one name list outright (the detail panel's ✕ and ＋). */
export async function setNames(
  target: MediaTarget,
  field: NameField,
  names: string[]
): Promise<MediaDetail> {
  if (!(NAME_FIELDS as readonly string[]).includes(field)) {
    throw new AppError('taxonomy_unknown_kind', { kind: field })
  }
  const next = await normalise(field, names)
  return editMedia(target.libraryId, target.mediaId, (meta) => ({
    ...meta,
    [field]: next,
    updatedAt: new Date().toISOString()
  }))
}

export interface UserMetaPatch {
  title?: string
  rating?: number | null
  favorite?: boolean
  notes?: string
}

/**
 * Replace the media's list of where it came from.
 *
 * Duplicates are dropped by URL — the same address filed twice says nothing
 * twice — and the order the user put them in is kept, because the first one is
 * the one they consider canonical.
 */
export async function setSources(
  target: MediaTarget,
  sources: { type: 'eroscripts' | 'original' | 'other'; url: string }[]
): Promise<MediaDetail> {
  const seen = new Set<string>()
  const unique = sources.filter((s) => {
    const key = s.url.trim()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
  return editMedia(target.libraryId, target.mediaId, (meta) => ({
    ...meta,
    sources: unique.map((s) => ({ type: s.type, url: s.url.trim() })),
    updatedAt: new Date().toISOString()
  }))
}

export async function setUserMeta(target: MediaTarget, patch: UserMetaPatch): Promise<MediaDetail> {
  return editMedia(target.libraryId, target.mediaId, (meta) => {
    const { rating: _r, favorite: _f, notes: _n, ...restUser } = meta.userMeta
    return {
      ...meta,
      ...(patch.title !== undefined ? { title: patch.title.trim() || undefined } : {}),
      userMeta: {
        ...restUser,
        // Absent beats present-and-empty: an unrated media has no rating, it
        // does not have a rating of zero.
        ...(patch.rating !== undefined
          ? patch.rating === null
            ? {}
            : { rating: patch.rating }
          : meta.userMeta.rating !== undefined
            ? { rating: meta.userMeta.rating }
            : {}),
        ...(patch.favorite !== undefined
          ? patch.favorite
            ? { favorite: true }
            : {}
          : meta.userMeta.favorite
            ? { favorite: true }
            : {}),
        ...(patch.notes !== undefined
          ? patch.notes.trim()
            ? { notes: patch.notes }
            : {}
          : meta.userMeta.notes
            ? { notes: meta.userMeta.notes }
            : {})
      },
      updatedAt: new Date().toISOString()
    }
  })
}

/** Mark a media as VR in the given format, or as not VR with `flat`. */
export async function setVr(target: MediaTarget, vr: VrFormat): Promise<MediaDetail> {
  return editMedia(target.libraryId, target.mediaId, (meta) => ({
    ...meta,
    vr,
    updatedAt: new Date().toISOString()
  }))
}

/* ------------------------------------------------------------------ *
 * Batch editing
 * ------------------------------------------------------------------ */

export interface BatchEdit {
  /** field → names to add to every target. */
  add?: Partial<Record<NameField, string[]>>
  /** field → names to remove from every target. */
  remove?: Partial<Record<NameField, string[]>>
  /** field → the exact list to set, replacing whatever is there. */
  replace?: Partial<Record<NameField, string[]>>
  rating?: number | null
  favorite?: boolean
}

export interface BatchResult {
  changed: number
  failed: { mediaId: string; reason: string }[]
}

/**
 * Apply one edit to many media. Each one is written on its own: a failure part
 * way through leaves the ones before it edited rather than rolling back, which
 * matches what the user sees — the grid updates as it goes.
 */
export async function applyBatch(targets: MediaTarget[], edit: BatchEdit): Promise<BatchResult> {
  // Normalising once rather than per media: forty targets would otherwise mean
  // forty passes over the taxonomy for the same three tag names.
  const add = {} as Partial<Record<NameField, string[]>>
  const remove = {} as Partial<Record<NameField, string[]>>
  const replace = {} as Partial<Record<NameField, string[]>>
  for (const field of NAME_FIELDS) {
    if (edit.add?.[field]?.length) add[field] = await normalise(field, edit.add[field]!)
    if (edit.remove?.[field]?.length) remove[field] = dedupe(edit.remove[field]!)
    if (edit.replace?.[field]) replace[field] = await normalise(field, edit.replace[field]!)
  }

  const result: BatchResult = { changed: 0, failed: [] }
  for (const target of targets) {
    try {
      await editMedia(target.libraryId, target.mediaId, (meta) => applyOne(meta, { add, remove, replace, ...edit }))
      result.changed += 1
    } catch (e) {
      result.failed.push({ mediaId: target.mediaId, reason: String((e as Error)?.message ?? e) })
    }
  }
  return result
}

function applyOne(meta: MediaMeta, edit: BatchEdit): MediaMeta {
  const next: MediaMeta = { ...meta, updatedAt: new Date().toISOString() }

  for (const field of NAME_FIELDS) {
    const replacement = edit.replace?.[field]
    if (replacement) {
      next[field] = replacement
      continue
    }
    const current = meta[field]
    const removals = new Set((edit.remove?.[field] ?? []).map((n) => n.toLowerCase()))
    const kept = current.filter((n) => !removals.has(n.toLowerCase()))
    const additions = (edit.add?.[field] ?? []).filter(
      (n) => !kept.some((k) => k.toLowerCase() === n.toLowerCase())
    )
    if (removals.size > 0 || additions.length > 0) next[field] = [...kept, ...additions]
  }

  if (edit.rating !== undefined || edit.favorite !== undefined) {
    const { rating: _r, favorite: _f, ...restUser } = meta.userMeta
    next.userMeta = {
      ...restUser,
      ...(edit.rating !== undefined
        ? edit.rating === null
          ? {}
          : { rating: edit.rating }
        : meta.userMeta.rating !== undefined
          ? { rating: meta.userMeta.rating }
          : {}),
      ...(edit.favorite !== undefined
        ? edit.favorite
          ? { favorite: true }
          : {}
        : meta.userMeta.favorite
          ? { favorite: true }
          : {})
    }
  }

  return next
}

/* ------------------------------------------------------------------ *
 * Taxonomy edits that reach into sidecars
 * ------------------------------------------------------------------ */

/**
 * Rewrite one name across every started library. This is what a rename, a
 * merge and a delete all reduce to: `to === null` strips the name instead.
 *
 * Names, not ids, is what makes this necessary — and it is the same trade that
 * makes a sidecar readable on its own years later.
 */
export async function rewriteName(
  kind: EntityKind,
  from: string,
  to: string | null
): Promise<number> {
  const field = kind as NameField
  let changed = 0
  for (const { libraryId, db } of listStartedLibraries()) {
    for (const mediaId of db.idsWithName(field, from)) {
      const edited = await editMedia(libraryId, mediaId, (meta) => {
        const kept = meta[field].filter((n) => n.toLowerCase() !== from.toLowerCase())
        const merging = to !== null && kept.some((n) => n.toLowerCase() === to.toLowerCase())
        const next = to && !merging ? [...kept, to] : kept
        return {
          ...meta,
          [field]: next,
          ...(field === 'playlists' ? { playlistRanks: movedRank(meta, from, to, merging) } : {}),
          updatedAt: new Date().toISOString()
        }
      }).catch((e) => {
        console.error(`[library] could not rewrite ${from} on ${mediaId}:`, e)
        return null
      })
      if (edited) changed += 1
    }
  }
  return changed
}

/**
 * Carry a playlist's position across a rename, drop it on a delete.
 *
 * Without this the sidecar's own reconciliation would throw the position away
 * the moment the name it is filed under stops existing — a rename would quietly
 * shuffle a playlist the user had spent time ordering.
 *
 * A merge is the exception: the media is already in the destination list at
 * some position, and that one is the truth. Two positions cannot both be right,
 * and the one that was already there is the one the user can see.
 */
function movedRank(
  meta: MediaMeta,
  from: string,
  to: string | null,
  merging: boolean
): MediaMeta['playlistRanks'] {
  const next = { ...meta.playlistRanks }
  const key = Object.keys(next).find((n) => n.toLowerCase() === from.toLowerCase())
  if (key === undefined) return next
  const rank = next[key]!
  delete next[key]
  if (to && !merging) next[to] = rank
  return next
}

export type { MediaEditor }
