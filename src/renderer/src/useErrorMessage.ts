import { useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { AppIpcError } from '@shared/errors'

/**
 * Turns any caught value into a localized, user-facing message.
 * AppIpcError → translated `errors.<code>`; anything else → `errors.unknown`.
 *
 * The returned function keeps the same identity for the life of the component.
 * It is named in the dependency array of about thirty effects and callbacks
 * across the app; handing back a fresh closure each render re-ran every one of
 * them on every render. In the script player that meant re-fetching settings
 * and re-enumerating serial ports on each pointer move of a range slider, and
 * the re-fetch overwrote the value being dragged with the one still on disk.
 *
 * `t` is read through a ref so the latest translation is used without the
 * identity changing. Messages are stored as plain strings once formatted, so
 * nothing re-translates on a language switch either way.
 */
export function useErrorMessage(): (error: unknown) => string {
  const { t } = useTranslation()
  const translate = useRef(t)
  translate.current = t

  return useCallback((error: unknown): string => {
    if (error instanceof AppIpcError) {
      return translate.current(`errors.${error.code}`, error.params)
    }
    return translate.current('errors.unknown', {
      message: error instanceof Error ? error.message : String(error)
    })
  }, [])
}
