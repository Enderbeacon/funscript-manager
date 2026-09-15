import { useEffect, useState } from 'react'
import { ipcInvoke } from './ipc'

/**
 * Pictures that come over IPC as data URLs — thumbnails and heatmap strips.
 *
 * Session-level caches, because the lists that show these unmount their rows
 * while scrolling: VirtuosoGrid throws a card away the moment it leaves the
 * viewport, and without a cache scrolling back up refetches every image.
 *
 * Shared by the grid, the queue and the playlists, so a video looked at in one
 * of them is already drawn in the others.
 */

const LIMIT = 1000

export const heatmapCache = new Map<string, string | null>()
export const thumbCache = new Map<string, string | null>()

/** Files on disk have changed, so what was drawn from them may be wrong. */
export function clearImageCaches(): void {
  heatmapCache.clear()
  thumbCache.clear()
}

export default function CachedIpcImage({
  className,
  cache,
  channel,
  libraryId,
  mediaId,
  epoch = 0
}: {
  className: string
  cache: Map<string, string | null>
  channel: 'media:getHeatmap' | 'media:getThumbnail'
  libraryId: string
  mediaId: string
  /** Bumped by the caller to force a refetch after the file changed. */
  epoch?: number
}): React.JSX.Element | null {
  const key = `${libraryId}/${mediaId}`
  const [src, setSrc] = useState<string | null>(() => cache.get(key) ?? null)

  useEffect(() => {
    const cached = cache.get(key)
    if (cached !== undefined) {
      setSrc(cached)
      return
    }
    let alive = true
    ipcInvoke(channel, { libraryId, mediaId })
      .then(({ dataUrl }) => {
        if (cache.size > LIMIT) cache.clear()
        cache.set(key, dataUrl)
        if (alive) setSrc(dataUrl)
      })
      .catch(() => {}) // decorative; a row without an image is fine
    return () => {
      alive = false
    }
  }, [cache, channel, key, libraryId, mediaId, epoch])

  return src ? <img className={className} src={src} alt="" /> : null
}
