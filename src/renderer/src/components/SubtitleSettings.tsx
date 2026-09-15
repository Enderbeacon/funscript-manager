import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { RotateCcw, X } from 'lucide-react'
import type { SubtitleLook } from './SubtitleLayer'

/**
 * How the subtitle looks, set while watching.
 *
 * Inside the picture rather than on the settings page, and inside it rather
 * than on the window: full screen paints nothing but the picture, and a panel
 * anywhere else would be invisible exactly when someone is most likely to
 * find the text too small.
 *
 * Every change lands on the picture behind at once. The sample line at the top
 * is for the gap between two lines of speech, where there would otherwise be
 * nothing on screen to judge a colour by.
 */

/** Six that stay readable over a picture; the rest is the colour well. */
const SWATCHES = ['#ffffff', '#f5e663', '#8be9fd', '#7ee787', '#ffb4a2', '#111111']

/** Nudge sizes, in seconds. Small for lip-sync, large for a wrong file. */
const NUDGES = [-0.5, -0.1, 0.1, 0.5]

export default function SubtitleSettings({
  look,
  onLook,
  offsetMs,
  onOffset,
  onClose
}: {
  look: SubtitleLook
  onLook: (next: SubtitleLook) => void
  offsetMs: number
  onOffset: (ms: number) => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()

  // Escape closes this and stops there: the same key closes the picture, and
  // taking the video away because someone dismissed a panel is not the deal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const set = (patch: Partial<SubtitleLook>): void => onLook({ ...look, ...patch })

  return (
    <div className="subtitle-settings">
      <div className="subs-head">
        <span className="grow">{t('player.subtitles.settings')}</span>
        <button className="video-btn" title={t('common.close')} onClick={onClose}>
          <X size={13} />
        </button>
      </div>

      <div
        className={`subs-sample${look.background ? ' boxed' : ''}`}
        style={
          {
            '--sub-color': look.color,
            '--sub-opacity': look.opacity / 100,
            '--sub-bg': look.backgroundOpacity / 100
          } as React.CSSProperties
        }
      >
        <span style={{ fontSize: `${look.fontScale * 3.2}px` }}>{t('player.subtitles.sample')}</span>
      </div>

      <label className="subs-row">
        <span>{t('player.subtitles.size')}</span>
        <input
          type="range"
          min={2}
          max={12}
          step={0.2}
          value={look.fontScale}
          onChange={(e) => set({ fontScale: Number(e.target.value) })}
        />
      </label>

      <div className="subs-row">
        <span>{t('player.subtitles.color')}</span>
        <div className="subs-swatches">
          {SWATCHES.map((hex) => (
            <button
              key={hex}
              className={`subs-swatch${look.color.toLowerCase() === hex ? ' on' : ''}`}
              style={{ background: hex }}
              onClick={() => set({ color: hex })}
            />
          ))}
          <input
            type="color"
            className="subs-well"
            value={look.color}
            onChange={(e) => set({ color: e.target.value })}
          />
        </div>
      </div>

      <label className="subs-row">
        <span>{t('player.subtitles.opacity')}</span>
        <input
          type="range"
          min={20}
          max={100}
          value={look.opacity}
          onChange={(e) => set({ opacity: Number(e.target.value) })}
        />
      </label>

      <label className="subs-row">
        <span>{t('player.subtitles.background')}</span>
        <input
          type="checkbox"
          checked={look.background}
          onChange={(e) => set({ background: e.target.checked })}
        />
      </label>

      <label className={`subs-row${look.background ? '' : ' off'}`}>
        <span>{t('player.subtitles.backgroundOpacity')}</span>
        <input
          type="range"
          min={0}
          max={100}
          disabled={!look.background}
          value={look.backgroundOpacity}
          onChange={(e) => set({ backgroundOpacity: Number(e.target.value) })}
        />
      </label>

      <label className="subs-row">
        <span>{t('player.subtitles.position')}</span>
        <input
          type="range"
          min={0}
          max={40}
          value={look.bottomOffset}
          onChange={(e) => set({ bottomOffset: Number(e.target.value) })}
        />
      </label>

      <div className="subs-row">
        <span>{t('player.subtitles.delay')}</span>
        <div className="subs-nudge">
          {NUDGES.map((step) => (
            <button key={step} onClick={() => onOffset(offsetMs + Math.round(step * 1000))}>
              {step > 0 ? `+${step}s` : `${step}s`}
            </button>
          ))}
          <span className="subs-offset">{(offsetMs / 1000).toFixed(1)}s</span>
          <button title={t('player.subtitles.resetDelay')} onClick={() => onOffset(0)}>
            <RotateCcw size={12} />
          </button>
        </div>
      </div>
    </div>
  )
}
