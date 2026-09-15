import { useEffect, useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'

/**
 * Where to draw a menu that hangs off a button.
 *
 * Every card in this app has a `backdrop-filter`, and that makes each card its
 * own stacking context: a menu drawn inside one cannot be raised above the card
 * that comes after it, whatever z-index it is given. So menus are rendered into
 * `document.body` instead, which means they need real viewport coordinates —
 * this works them out, and keeps them from opening off the bottom or the side
 * of the screen.
 */

const GAP = 4

export interface PopoverOptions {
  /** Tallest the menu may be; it shrinks further when the room is smaller. */
  maxHeight?: number
  /** Below this much room underneath, the menu opens upwards instead. */
  minRoom?: number
  /** Match the anchor's width (a select), rather than keeping the menu's own. */
  matchWidth?: boolean
}

/**
 * Viewport-fixed placement for `anchor`, recomputed each time it opens.
 *
 * Returns null until measured, so a caller renders nothing rather than one
 * frame in the top-left corner. Anything that moves the anchor — a scroll, a
 * resize — closes the menu through `onDismiss`: a menu pinned to the viewport
 * would otherwise drift away from the button it belongs to.
 */
export function usePopover(
  anchor: RefObject<HTMLElement | null>,
  open: boolean,
  onDismiss: () => void,
  options: PopoverOptions = {}
): CSSProperties | null {
  const { maxHeight = 320, minRoom = 180, matchWidth = false } = options
  const [style, setStyle] = useState<CSSProperties | null>(null)

  useLayoutEffect(() => {
    if (!open || !anchor.current) {
      setStyle(null)
      return
    }
    const rect = anchor.current.getBoundingClientRect()
    const below = window.innerHeight - rect.bottom - GAP
    const above = rect.top - GAP
    // Downwards unless it will not fit and upwards is roomier — a menu opening
    // down is what the button's caret promises.
    const dropUp = below < minRoom && above > below
    /*
     * Sideways is the same question, and it has to be answered without the
     * menu's width: nothing has been laid out yet when this runs. So the side
     * is taken from where the anchor is — a button in the right half hangs its
     * menu from its right edge, which is the only way a menu opened next to the
     * window's edge stays on screen.
     */
    const flipRight = rect.left > window.innerWidth / 2
    setStyle({
      ...(flipRight
        ? { right: Math.round(Math.max(GAP, window.innerWidth - rect.right)) }
        : { left: Math.round(Math.max(GAP, rect.left)) }),
      maxWidth: Math.round(window.innerWidth - GAP * 2),
      ...(matchWidth ? { minWidth: Math.round(rect.width) } : {}),
      ...(dropUp
        ? { bottom: Math.round(window.innerHeight - rect.top + GAP) }
        : { top: Math.round(rect.bottom + GAP) }),
      maxHeight: Math.min(maxHeight, Math.max(120, dropUp ? above : below))
    })
  }, [open, anchor, maxHeight, minRoom, matchWidth])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss()
    }
    /**
     * Only a scroll that carries the button away closes the menu.
     *
     * The listener has to be a capturing one to see a nested container scroll
     * at all, which means it also sees scrolls that have nothing to do with the
     * anchor — including the menu's own list, and a text input scrolling
     * sideways because a long name was pasted into it. Dismissing on those
     * made pasting a name shut the menu, and then reopening it shut it again
     * the moment focus put the caret back at the end of the text.
     */
    const onScroll = (e: Event): void => {
      const button = anchor.current
      const scrolled = e.target
      if (button && scrolled instanceof Node && !scrolled.contains(button)) return
      onDismiss()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onDismiss)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onDismiss)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, onDismiss, anchor])

  return style
}
