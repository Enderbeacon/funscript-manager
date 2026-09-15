import { useCallback, useEffect, useSyncExternalStore } from 'react'

/**
 * Floating panels that overlap, ordered the way windows are.
 *
 * The detail view, the batch panel and the playback drawer all occupy the same
 * strip down the right-hand side, and they belong to different owners: the
 * first two are the media page's, the drawer is the app's. A fixed z-index per
 * owner meant one of them was permanently on top — open a video from a queue
 * row and the queue you came from was buried, with no way to get it back but
 * closing the video.
 *
 * So stacking is not a property of the panel any more, it is a record of what
 * the user touched last. Opening a panel or clicking anywhere in it brings it
 * forward; everything else keeps the place it had.
 *
 * Where a panel *sits* is deliberately not part of this: each keeps its own
 * inset, so raising one changes what is in front and never moves anything.
 * A panel that jumped 12px sideways when you clicked it would read as a bug.
 */

/** Above the nav rail (30), below the top bar (50). */
const BASE_Z = 40

/** Open panels, back to front. */
let order: string[] = []
const closers = new Map<string, () => void>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Stable between changes, which is what `useSyncExternalStore` requires. */
function snapshot(): string[] {
  return order
}

export function raiseSurface(id: string): void {
  if (order[order.length - 1] === id) return
  order = [...order.filter((other) => other !== id), id]
  emit()
}

/**
 * Close the front-most panel — Escape, or a click on empty page.
 *
 * `accept` narrows which panels count: a click on the grid dismisses the page's
 * own layers but leaves the drawer alone, because the drawer is a tool the user
 * put there rather than something that happened to be in the way.
 */
export function closeFrontSurface(accept: (id: string) => boolean = () => true): boolean {
  for (let i = order.length - 1; i >= 0; i--) {
    const id = order[i]
    if (id === undefined || !accept(id)) continue
    closers.get(id)?.()
    return true
  }
  return false
}

export interface SurfaceHandle {
  /** For the panel's own `style`. */
  z: number
  /** Whether nothing is drawn over it — the dimming of the ones behind. */
  front: boolean
  /** Call on pointer-down anywhere in the panel. */
  raise: () => void
}

/** Register a panel for as long as it is open. Mounting brings it forward. */
export function useSurface(id: string, onClose: () => void): SurfaceHandle {
  const open = useSyncExternalStore(subscribe, snapshot)

  useEffect(() => {
    raiseSurface(id)
    return () => {
      order = order.filter((other) => other !== id)
      closers.delete(id)
      emit()
    }
  }, [id])

  // Re-recorded every render rather than tied to the effect above: the callback
  // usually closes over fresh state, and re-registering would re-raise.
  useEffect(() => {
    closers.set(id, onClose)
  })

  const at = open.indexOf(id)
  return {
    // Before the effect has run the panel is not in the list yet; putting it
    // one past the end means its first painted frame is already on top.
    z: BASE_Z + (at < 0 ? open.length : at),
    front: at < 0 || open[open.length - 1] === id,
    raise: useCallback(() => raiseSurface(id), [id])
  }
}

/** Whether `id` is the panel in front. For buttons that raise before closing. */
export function useIsFrontSurface(id: string): boolean {
  const open = useSyncExternalStore(subscribe, snapshot)
  return open[open.length - 1] === id
}

/**
 * Escape closes the front-most panel, wherever focus is. Installed once, by the
 * app: the panels no longer each guess whether they are the one being asked.
 */
export function useSurfaceEscape(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // Let a text field have its own Escape (the chip pickers close on it).
      const el = document.activeElement
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return
      if (closeFrontSurface()) e.stopPropagation()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
