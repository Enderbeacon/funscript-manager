import { AppError } from '@shared/errors'
import type { VrFormatPatch } from '@shared/schemas/playback'
import type { MediaMeta } from '@shared/schemas/media-meta'
import type { VrFormat } from '@shared/schemas/vr-video'
import { FLAT_VR_FORMAT } from '@shared/vr-video'
import { readSidecar, sidecarPathFor, writeSidecar } from '../library/sidecar'
import { setVideoIntent, videoIntent } from './internal/surface'

/**
 * How the file on the built-in picture is marked. Read from the sidecar here
 * and handed to the window with the file; an unmarked file plays flat.
 */

/** Tell the picture how the file it is showing is marked. */
export function applyVrFormat(meta: MediaMeta): void {
  setVideoIntent({ vr: meta.vr ?? FLAT_VR_FORMAT })
}

/** A media was marked elsewhere; if it is the one on the picture, show it so. */
export function showVrFormatIfPlaying(absPath: string, vr: VrFormat): void {
  if (videoIntent().media?.path === absPath) setVideoIntent({ vr })
}

/**
 * Change how the file on screen is marked, from the picture's menu. The
 * change is applied to the format the picture is showing and stored whole.
 */
export async function setPlayingVrFormat(patch: VrFormatPatch): Promise<void> {
  const intent = videoIntent()
  const path = intent.media?.path
  if (!path) throw new AppError('media_not_found')
  const sidecarPath = sidecarPathFor(path)
  const sidecar = await readSidecar(sidecarPath)
  if (!sidecar.ok) throw new AppError('media_not_found')

  const vr: VrFormat = { ...intent.vr, ...patch }
  await writeSidecar(sidecarPath, { ...sidecar.meta, vr, updatedAt: new Date().toISOString() })
  showVrFormatIfPlaying(path, vr)
}
