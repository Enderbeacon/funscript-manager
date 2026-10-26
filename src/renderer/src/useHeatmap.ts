import { useEffect, useState } from 'react'
import { ipcInvoke, ipcOn } from './ipc'

/** A live strip follows script selection, media duration and library edits. */
export function useHeatmap(selection: {
  libraryId: string
  mediaId: string
  /** Undefined selects the default; null means no script is playing. */
  scriptVersionId?: string | null
  durationMs?: number | null
} | null): string | null {
  const libraryId = selection?.libraryId
  const mediaId = selection?.mediaId
  const scriptVersionId = selection?.scriptVersionId
  const durationMs = selection?.durationMs && selection.durationMs > 0
    ? selection.durationMs
    : undefined
  const [epoch, setEpoch] = useState(0)
  const [image, setImage] = useState<{ key: string; dataUrl: string | null } | null>(null)
  const key = JSON.stringify([
    libraryId, mediaId, scriptVersionId === undefined ? 'default' : scriptVersionId, durationMs, epoch
  ])

  useEffect(() => {
    if (!libraryId) return
    return ipcOn('event:media-changed', (event) => {
      if (event.libraryId === libraryId) setEpoch((value) => value + 1)
    })
  }, [libraryId])

  useEffect(() => {
    if (!libraryId || !mediaId || scriptVersionId === null) return
    let alive = true
    ipcInvoke('media:getHeatmap', {
      libraryId, mediaId,
      ...(scriptVersionId !== undefined ? { scriptVersionId } : {}),
      ...(durationMs !== undefined ? { durationMs } : {})
    })
      .then(({ dataUrl }) => {
        if (alive) setImage({ key, dataUrl })
      })
      .catch(() => {
        if (alive) setImage({ key, dataUrl: null })
      })
    return () => {
      alive = false
    }
  }, [libraryId, mediaId, scriptVersionId, durationMs, key])

  // Hide the previous version immediately, including while IPC is pending.
  return libraryId && mediaId && scriptVersionId !== null && image?.key === key ? image.dataUrl : null
}
