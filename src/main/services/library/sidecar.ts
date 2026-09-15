import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { SIDECAR_SUFFIX } from '@shared/constants'
import {
  AnyMediaMetaSchema,
  MEDIA_META_VERSION,
  MediaMetaSchema,
  type FileFingerprint,
  type MediaInfo,
  type MediaMeta
} from '@shared/schemas/media-meta'
import { atomicWriteText } from '../../util/atomic-json'
import type { GroupedCompanions } from './companion-grouping'

/**
 * Sidecar (`<media filename>.meta.json`) I/O. The sidecar is the source of
 * truth: every write validates against MediaMetaSchema and lands
 * via `.tmp` + atomic rename so a crash never leaves a corrupt file.
 */

export function sidecarPathFor(mediaPath: string): string {
  return mediaPath + SIDECAR_SUFFIX
}

export function isSidecarFile(name: string): boolean {
  return name.toLowerCase().endsWith(SIDECAR_SUFFIX)
}

/** `video.mp4.meta.json` → `video.mp4` (sibling path of the sidecar). */
export function mediaPathForSidecar(sidecarPath: string): string {
  return sidecarPath.slice(0, sidecarPath.length - SIDECAR_SUFFIX.length)
}

export type SidecarReadResult =
  | { ok: true; meta: MediaMeta }
  /** `newer`: written by a later build of the app, and left strictly alone. */
  | { ok: false; error: 'unreadable' | 'invalid' | 'newer' }

/** Read + validate a sidecar. Invalid files are reported, never thrown. */
export async function readSidecar(sidecarPath: string): Promise<SidecarReadResult> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(sidecarPath, 'utf-8'))
  } catch {
    return { ok: false, error: 'unreadable' }
  }
  const version = (raw as { schemaVersion?: unknown } | null)?.schemaVersion
  if (typeof version === 'number' && version > MEDIA_META_VERSION) {
    // Someone ran a newer build on this library. Its file says more than this
    // build can read, and rewriting it here would throw the difference away.
    return { ok: false, error: 'newer' }
  }
  const parsed = AnyMediaMetaSchema.safeParse(raw)
  return parsed.success ? { ok: true, meta: parsed.data } : { ok: false, error: 'invalid' }
}

/** Validate and atomically write a sidecar. */
export async function writeSidecar(sidecarPath: string, meta: MediaMeta): Promise<void> {
  const validated = MediaMetaSchema.parse(meta)
  await atomicWriteText(sidecarPath, JSON.stringify(validated, null, 2))
}

/** Build a fresh sidecar for a newly discovered media file. */
export function buildNewSidecar(
  fingerprint: FileFingerprint,
  companions: GroupedCompanions,
  mediaInfo?: MediaInfo | null
): MediaMeta {
  const now = new Date().toISOString()
  return MediaMetaSchema.parse({
    schemaVersion: MEDIA_META_VERSION,
    id: randomUUID(),
    fileFingerprint: fingerprint,
    ...(mediaInfo ? { mediaInfo } : {}),
    scriptVersions: companions.scriptVersions,
    subtitles: companions.subtitles,
    createdAt: now,
    updatedAt: now
  })
}

/**
 * A sidecar is orphaned when its companion media file no longer exists
 * (the user moved/deleted the video without its sidecar). The caller
 * decides what to do (mark missing, offer re-association).
 */
export function isOrphanSidecar(sidecarPath: string): boolean {
  return !existsSync(mediaPathForSidecar(sidecarPath))
}

/** Convenience: sidecar's directory + media filename for grouping calls. */
export function mediaNameForSidecar(sidecarPath: string): { dir: string; mediaName: string } {
  const mediaPath = mediaPathForSidecar(sidecarPath)
  return { dir: dirname(mediaPath), mediaName: basename(mediaPath) }
}
