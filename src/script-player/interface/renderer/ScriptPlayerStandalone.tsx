import { useEffect } from 'react'
import { applyLanguageSetting } from '@/i18n'
import { ipcInvoke } from '@/ipc'
import { applyPaletteSetting, applyThemeSetting } from '@/theme'
import ScriptPlayerPanel from './ScriptPlayerPanel'

export default function ScriptPlayerStandalone(): React.JSX.Element {
  useEffect(() => {
    ipcInvoke('settings:get').then((settings) => {
      applyLanguageSetting(settings.ui.language)
      applyPaletteSetting(settings.ui.palette)
      applyThemeSetting(settings.ui.theme)
    }).catch(() => {})
  }, [])
  return <ScriptPlayerPanel standalone />
}
