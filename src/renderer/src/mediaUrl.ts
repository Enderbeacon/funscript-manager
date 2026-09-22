import { ipcInvoke } from './ipc'

/**
 * Inline-preview source for a media item, served by the main-process
 * `fsmgr-media://` streaming protocol (see src/main/services/media-protocol.ts).
 * Only the containers Chromium opens get a preview; everything else falls back
 * to the static thumbnail, and so does a file in one of these whose codec it
 * cannot decode. Previews never convert: a card hover is not worth an ffmpeg
 * run. MKV is here because Chromium does open it — the built-in player plays
 * one as it is when its codecs allow.
 */

const PREVIEWABLE = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv', 'ogg'])

/** The key the handler requires on every URL; fetched once per page load. */
let accessKey = ''

/** Read the key. Awaited before the page first renders. */
export async function loadMediaAccessKey(): Promise<void> {
  try {
    accessKey = (await ipcInvoke('media:accessKey')).key
  } catch {
    // No key: every URL is a 404, and each preview falls back to its still.
  }
}

export function isPreviewable(fileName: string): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase()
  return ext ? PREVIEWABLE.has(ext) : false
}

export function mediaPreviewUrl(libraryId: string, mediaId: string): string {
  const q = new URLSearchParams({ lib: libraryId, id: mediaId, k: accessKey })
  return `fsmgr-media://media/?${q.toString()}`
}

/**
 * The same stream, addressed by path — what the built-in player is given, and
 * what every other player is given too. The handler still resolves it through
 * the library index, so a path outside every library is a 404 rather than a
 * way to read any file on the disk.
 */
export function mediaFileUrl(path: string): string {
  const q = new URLSearchParams({ p: path, k: accessKey })
  return `fsmgr-media://file/?${q.toString()}`
}
