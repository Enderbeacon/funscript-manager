import { useEffect, useState } from 'react'
import ScriptPlayerPanel from '@script-player/interface/renderer/ScriptPlayerPanel'
import { VrModeContext } from '@script-player/interface/renderer/vrMode'
import { ipcInvoke } from '../ipc'
import { useAppearance } from '../useAppearance'
import { useVrKeyboard } from './useVrKeyboard'
import './vr-surfaces.css'
import './vr-script-player.css'

/**
 * The script player on its own panel inside the headset, opened from the main
 * VR panel.
 *
 * It is the desktop player itself, so every setting it has is here and stays
 * in step with the desktop; VR mode swaps out what a laser cannot use.
 */
export default function VrScriptPlayer(): React.JSX.Element {
  useVrKeyboard()
  const settings = useAppearance()

  const background = settings?.vr.scriptPlayer.background ?? 1
  useEffect(() => {
    document.documentElement.style.setProperty('--vr-bg-alpha', String(background))
  }, [background])

  return (
    <VrModeContext.Provider value={true}>
      <ScriptPlayerPanel onClose={() => void ipcInvoke('vr:panel', { action: 'hide' }).catch(() => {})} />
      <HoverLabel />
    </VrModeContext.Provider>
  )
}

/** How long the laser rests on a control before its name shows. */
const HOVER_DELAY_MS = 400
const LABEL_HALF_WIDTH = 130

/**
 * The name of the control under the laser.
 *
 * The desktop player names its icon buttons in tooltips, and a tooltip is a
 * window of its own that an off-screen page never draws. This shows the same
 * text inside the page.
 */
function HoverLabel(): React.JSX.Element | null {
  const [label, setLabel] = useState<{ text: string; left: number; top: number; below: boolean } | null>(null)

  useEffect(() => {
    let current: Element | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const clear = (): void => {
      clearTimeout(timer)
      setLabel(null)
    }
    const onOver = (event: MouseEvent): void => {
      const target = event.target instanceof Element ? event.target.closest('[title]') : null
      if (target === current) return
      current = target
      clear()
      const text = target?.getAttribute('title')
      if (!target || !text) return
      timer = setTimeout(() => {
        const rect = target.getBoundingClientRect()
        const below = rect.bottom + 60 < window.innerHeight
        setLabel({
          text,
          left: Math.min(window.innerWidth - LABEL_HALF_WIDTH, Math.max(LABEL_HALF_WIDTH, rect.left + rect.width / 2)),
          top: below ? rect.bottom + 6 : rect.top - 6,
          below
        })
      }, HOVER_DELAY_MS)
    }
    const onLeave = (): void => {
      current = null
      clear()
    }
    document.addEventListener('mouseover', onOver)
    document.addEventListener('mousedown', clear)
    document.documentElement.addEventListener('mouseleave', onLeave)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mouseover', onOver)
      document.removeEventListener('mousedown', clear)
      document.documentElement.removeEventListener('mouseleave', onLeave)
    }
  }, [])

  if (!label) return null
  return (
    <div
      className={`vr-hover-label${label.below ? '' : ' above'}`}
      style={{ left: label.left, top: label.top }}
    >
      {label.text}
    </div>
  )
}
