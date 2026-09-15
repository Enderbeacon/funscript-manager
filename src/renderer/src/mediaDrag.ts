/**
 * Dragging media out of the grid and onto something that will take it.
 *
 * The payload is the media the gesture is about, which is not always the card
 * under the pointer: dragging one of several ticked cards drags all of them,
 * because the tick is already a statement about what the next action applies
 * to and it would be strange for this one action to ignore it.
 *
 * A custom MIME type rather than `text/plain` so a drop target can tell our
 * cards apart from a file dragged in from Explorer, and so nothing outside the
 * app can be dropped into a playlist by accident.
 */

export const MEDIA_DRAG_TYPE = 'application/x-funscript-media'

export interface MediaDragTarget {
  libraryId: string
  mediaId: string
}

export function setMediaDrag(e: React.DragEvent, targets: MediaDragTarget[]): void {
  e.dataTransfer.setData(MEDIA_DRAG_TYPE, JSON.stringify(targets))
  e.dataTransfer.effectAllowed = 'copy'
}

/** Null when the drag is not ours — a file from the desktop, say. */
export function readMediaDrag(e: React.DragEvent): MediaDragTarget[] | null {
  const raw = e.dataTransfer.getData(MEDIA_DRAG_TYPE)
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    return parsed as MediaDragTarget[]
  } catch {
    return null
  }
}

/**
 * Whether a drag in progress is ours.
 *
 * `dragover` cannot read the data — the browser withholds it until the drop, so
 * a drag from another window cannot be inspected mid-flight — but the list of
 * types is always readable, and that is enough to decide whether to light up.
 */
export function isMediaDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(MEDIA_DRAG_TYPE)
}
