import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
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
 *
 * Where a library keeps its sidecars is SidecarStore's business; this file
 * only reads and writes the one it is given.
 */

/**
 * The sidecar path next to the media file. Only one of the places a sidecar
 * can be — a library may keep them elsewhere, so anything that means "this
 * media's sidecar" asks the library's SidecarStore instead.
 */
export function besideSidecarPath(mediaPath: string): string {
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
