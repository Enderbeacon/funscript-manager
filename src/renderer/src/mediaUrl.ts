/**
 * Inline-preview source for a media item, served by the main-process
 * `fsmgr-media://` streaming protocol (see src/main/services/media-protocol.ts).
 * Only the extensions Chromium can decode get a preview; everything else falls
 * back to the static thumbnail.
 */

const PREVIEWABLE = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv', 'ogg'])

export function isPreviewable(fileName: string): boolean {
  const ext = fileName.split('.').pop()?.toLowerCase()
  return ext ? PREVIEWABLE.has(ext) : false
}

export function mediaPreviewUrl(libraryId: string, mediaId: string): string {
  const q = new URLSearchParams({ lib: libraryId, id: mediaId })
  return `fsmgr-media://media/?${q.toString()}`
}

/**
 * The same stream, addressed by path — what the built-in player is given, and
 * what every other player is given too. The handler still resolves it through
 * the library index, so a path outside every library is a 404 rather than a
 * way to read any file on the disk.
 */
export function mediaFileUrl(path: string): string {
  const q = new URLSearchParams({ p: path })
  return `fsmgr-media://file/?${q.toString()}`
}
