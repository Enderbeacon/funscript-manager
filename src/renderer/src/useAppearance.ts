import { useEffect, useState } from 'react'
import type { Settings } from '@shared/schemas/app-config'
import { applyLanguageSetting } from './i18n'
import { ipcInvoke, ipcOn } from './ipc'
import { applyPaletteSetting, applyThemeSetting } from './theme'

function apply(settings: Settings): void {
  applyLanguageSetting(settings.ui.language)
  applyPaletteSetting(settings.ui.palette)
  applyThemeSetting(settings.ui.theme)
}

/**
 * For a window other than the main one: takes the theme, palette and language
 * from the settings, and follows them when they change anywhere else.
 *
 * Returns the settings as they stand, null until they have been read.
 */
export function useAppearance(): Settings | null {
  const [settings, setSettings] = useState<Settings | null>(null)
  useEffect(() => {
    let live = true
    ipcInvoke('settings:get')
      .then((loaded) => {
        if (!live) return
        apply(loaded)
        setSettings(loaded)
      })
      .catch(() => {})
    const off = ipcOn('event:settings-changed', (next) => {
      apply(next)
      setSettings(next)
    })
    return () => {
      live = false
      off()
    }
  }, [])
  return settings
}
