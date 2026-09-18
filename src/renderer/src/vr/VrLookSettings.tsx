import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import type { Settings } from '@shared/schemas/app-config'
import { VR_PANEL_MAX_HEIGHT, VR_PANEL_METRES, VR_PANEL_MIN_HEIGHT, VR_PANEL_WIDTH } from '@shared/vr'
import { ipcInvoke } from '../ipc'

type Look = Pick<Settings['vr'], 'main' | 'scriptPlayer'>

/** How often a dragged slider reaches the headset, at most. */
const SEND_EVERY_MS = 100

/**
 * The panels' sizes and how see-through they are, as a card over the main
 * panel. The panels change while a slider moves, so the right value can be
 * found by looking rather than by guessing and closing the card.
 */
export default function VrLookSettings({
  look,
  onClose,
  onError
}: {
  look: Look
  onClose: () => void
  onError: (e: unknown) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<Look>(look)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const waiting = useRef<Look | null>(null)

  // Follows changes made elsewhere, but not while a drag is still being sent:
  // an older value coming back would pull the slider out from under the laser.
  useEffect(() => {
    if (!timer.current) setDraft(look)
  }, [look])

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  // The whole of each panel's look goes every time: settings merge one level
  // deep, and a partial `main` would reset the rest of it.
  const save = (next: Look): void => {
    ipcInvoke('settings:update', { vr: { main: next.main, scriptPlayer: next.scriptPlayer } }).catch(onError)
  }

  const flush = (): void => {
    timer.current = null
    const next = waiting.current
    waiting.current = null
    if (next) {
      save(next)
      timer.current = setTimeout(flush, SEND_EVERY_MS)
    }
  }

  const change = <G extends keyof Look>(group: G, key: keyof Look[G], value: number): void => {
    const next = { ...draft, [group]: { ...draft[group], [key]: value } }
    setDraft(next)
    if (timer.current) {
      waiting.current = next
      return
    }
    save(next)
    timer.current = setTimeout(flush, SEND_EVERY_MS)
  }

  return (
    <div className="vr-sheet" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="vr-sheet-card vr-look" role="dialog" aria-label={t('vr.panelSettings')}>
        <header className="vr-sheet-head">
          <h2>{t('vr.panelSettings')}</h2>
          <button className="vr-icon-btn" aria-label={t('vr.close')} onClick={onClose}>
            <X size={28} />
          </button>
        </header>

        <div className="vr-look-columns">
          <section>
            <h3>{t('vr.mainPanel')}</h3>
            <Slider label={t('vr.size')} min={50} max={200} value={draft.main.size} onChange={(v) => change('main', 'size', v)} />
            <label className="vr-slider">
              <span className="vr-slider-label">{t('vr.height')}</span>
              <input
                type="range"
                min={VR_PANEL_MIN_HEIGHT}
                max={VR_PANEL_MAX_HEIGHT}
                step={40}
                value={draft.main.height}
                onChange={(e) => change('main', 'height', Number(e.target.value))}
              />
              {/* In the world, where it is what the viewer sees. */}
              <span className="vr-slider-value">
                {Math.round(((draft.main.height * VR_PANEL_METRES) / VR_PANEL_WIDTH) * draft.main.size * 100)} cm
              </span>
            </label>
            <Slider
              label={t('vr.wristSize')}
              min={50}
              max={200}
              value={draft.main.wristSize}
              onChange={(v) => change('main', 'wristSize', v)}
            />
            <Slider label={t('vr.opacity')} min={20} max={100} value={draft.main.opacity} onChange={(v) => change('main', 'opacity', v)} />
            <Slider
              label={t('vr.backgroundOpacity')}
              min={0}
              max={100}
              value={draft.main.background}
              onChange={(v) => change('main', 'background', v)}
            />
          </section>

          <section>
            <h3>{t('vr.scriptPlayer')}</h3>
            <Slider
              label={t('vr.size')}
              min={50}
              max={200}
              value={draft.scriptPlayer.size}
              onChange={(v) => change('scriptPlayer', 'size', v)}
            />
            <Slider
              label={t('vr.opacity')}
              min={20}
              max={100}
              value={draft.scriptPlayer.opacity}
              onChange={(v) => change('scriptPlayer', 'opacity', v)}
            />
            <Slider
              label={t('vr.backgroundOpacity')}
              min={0}
              max={100}
              value={draft.scriptPlayer.background}
              onChange={(v) => change('scriptPlayer', 'background', v)}
            />
          </section>
        </div>
      </div>
    </div>
  )
}

/** A factor shown and moved in whole percent, five at a time. */
function Slider({
  label,
  min,
  max,
  value,
  onChange
}: {
  label: string
  min: number
  max: number
  value: number
  onChange: (value: number) => void
}): React.JSX.Element {
  const percent = Math.round(value * 100)
  return (
    <label className="vr-slider">
      <span className="vr-slider-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={5}
        value={percent}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
      />
      <span className="vr-slider-value">{percent}%</span>
    </label>
  )
}
