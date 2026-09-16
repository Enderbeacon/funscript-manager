import { extname, join } from 'node:path'
import { AppError } from '@shared/errors'
import { AUDIO_EXTENSIONS } from '@shared/constants'
import type { MediaInfo } from '@shared/schemas/media-meta'
import type { VideoRoute, VideoRouteFallback } from '@shared/schemas/playback'
import { runnableFfmpeg } from '../../deps/binaries'
import { findByAbsPath } from '../../library/library-manager'
import { probeMedia } from '../../library/probe'
import { readSidecar, sidecarPathFor } from '../../library/sidecar'

/**
 * Decides how the built-in picture gets at a file: as it is, or rewritten by
 * ffmpeg on the way.
 *
 * Chromium plays a narrower set than a library holds. Which containers and
 * codecs it takes was measured rather than assumed — notably it opens MKV,
 * which is easy to believe it does not, and it plays an MKV whose audio is AC-3
 * with no sound and no error, which is why audio is checked as well as video.
 *
 * The decision leans on the codecs the library already read from the file.
 * When those are missing it probes the file now. Without ffmpeg there is no
 * probing either, and a file in a container Chromium opens is simply tried.
 */

/** Containers Chromium opens itself. */
const DIRECT_CONTAINERS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.ogv'])
/** Video codecs Chromium decodes everywhere. HEVC depends on the machine. */
const DIRECT_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1'])
const DIRECT_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac'])

export async function routeVideo(
  path: string,
  { hevc, fallback }: { hevc: boolean; fallback: VideoRouteFallback }
): Promise<VideoRoute> {
  const found = findByAbsPath(path)
  if (!found) throw new AppError('media_not_found')
  const abs = join(found.libraryRoot, found.mediaRelPath)
  const ext = extname(abs).toLowerCase()

  // An audio file has no picture to convert; Chromium plays every audio format
  // the library collects.
  if ((AUDIO_EXTENSIONS as readonly string[]).includes(ext)) return { kind: 'direct' }

  const ffmpegRuns = (await runnableFfmpeg()) !== null
  // Not read yet: read it now. Guessing is not good enough here, because the
  // silent AC-3 case never fails and so would never fall back.
  const info = (await knownInfo(abs)) ?? (ffmpegRuns ? await probeMedia(abs) : null)
  const videoOk = (codec: string | undefined): boolean =>
    codec !== undefined && (DIRECT_VIDEO.has(codec) || (hevc && codec === 'hevc'))

  if (fallback === 'none' && DIRECT_CONTAINERS.has(ext)) {
    // Nothing can be known without ffmpeg: try it as it is, and a failure
    // asks again.
    if (!info) return { kind: 'direct' }
    const audioOk = info.audioCodec === undefined || DIRECT_AUDIO.has(info.audioCodec)
    if (videoOk(info.videoCodec) && audioOk) return { kind: 'direct' }
  }

  const probed = ffmpegRuns ? info : null
  if (!probed) return { kind: 'needs_ffmpeg' }
  // Sound alone in a video container: there is no picture for ffmpeg to carry,
  // so the file as it is is all there is to try.
  if (probed.videoCodec === undefined) return { kind: 'direct' }

  // AVI stores no presentation times, so a copied video track arrives with its
  // frames in decode order and nothing to reorder them by. Converting it gives
  // them times again.
  const copyVideo =
    fallback !== 'encode' &&
    ext !== '.avi' &&
    (probed.videoCodec === 'h264' || (hevc && probed.videoCodec === 'hevc'))
  const audio =
    probed.audioCodec === undefined
      ? 'none'
      : fallback !== 'encode' && probed.audioCodec === 'aac'
        ? 'copy'
        : 'encode'

  const videoType = copyVideo && probed.videoCodec === 'hevc' ? 'hvc1.1.6.L93.B0' : 'avc1.640028'
  return {
    kind: 'stream',
    video: copyVideo ? 'copy' : 'encode',
    audio,
    videoCodec: copyVideo && probed.videoCodec === 'hevc' ? 'hevc' : 'h264',
    durationMs: probed.durationMs ?? null,
    mimeType: `video/mp4; codecs="${audio === 'none' ? videoType : `${videoType},mp4a.40.2`}"`
  }
}

/**
 * The codecs recorded for this file, if the library has read them. Null when
 * it has not — including a file that was probed and said nothing, since
 * nothing is not enough to decide on.
 */
async function knownInfo(abs: string): Promise<MediaInfo | null> {
  const sidecar = await readSidecar(sidecarPathFor(abs))
  const info = sidecar.ok ? sidecar.meta.mediaInfo : undefined
  return info && (info.videoCodec || info.audioCodec) ? info : null
}
