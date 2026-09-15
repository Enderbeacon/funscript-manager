import { useEffect } from 'react'

/**
 * Escape closes a modal.
 *
 * Modals do not close on a click outside them: a drag that starts in a text
 * field and ends on the backdrop is a click on the backdrop, and losing a
 * half-typed name to it is not a thing a dialog should be able to do. So the
 * ways out are all deliberate — Cancel, ✕, and this.
 */
export function useEscape(onEscape: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onEscape()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onEscape, enabled])
}
