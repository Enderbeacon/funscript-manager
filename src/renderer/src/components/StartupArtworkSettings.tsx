import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Settings } from '@shared/schemas/app-config'
import { ipcInvoke } from '../ipc'
import { useErrorMessage } from '../useErrorMessage'
import defaultArtwork from '../assets/brand/startup-artwork.svg'
import StartupArtworkSources from './StartupArtworkSources'

type Artwork = Settings['ui']['startupArtwork']

export default function StartupArtworkSettings({
  value,
  libraryId,
  onChange
}: {
  value: Artwork
  libraryId: string
  onChange: (value: Artwork) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation()
  const toMessage = useErrorMessage()
  const [preview, setPreview] = useState(defaultArtwork)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [intervalText, setIntervalText] = useState(String(value.intervalSeconds))
  const previewKey = JSON.stringify(value)

  useEffect(() => setIntervalText(String(value.intervalSeconds)), [value.intervalSeconds])

  useEffect(() => {
    let cancelled = false
    setPreview(defaultArtwork)
    if (value.mode !== 'default') {
      void ipcInvoke('app:startupArtwork').then(({ images }) => {
        if (!cancelled) setPreview(images[0] ?? defaultArtwork)
      }).catch(() => {})
    }
    return () => { cancelled = true }
  }, [previewKey, libraryId])

  const save = async (next: Artwork): Promise<void> => {
    setBusy(true)
    try {
      await onChange(next)
    } finally {
      setBusy(false)
    }
  }

  const browse = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const { path } = await ipcInvoke('dialog:pickImage', { title: t('settings.startupArtwork.choose'), svg: true })
      if (path) await onChange({ ...value, mode: 'custom', customPath: path })
    } catch (e) {
      setError(toMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const saveInterval = (): void => {
    const parsed = Number(intervalText)
    const intervalSeconds = Number.isFinite(parsed) ? Math.min(60, Math.max(1, Math.round(parsed))) : 6
    setIntervalText(String(intervalSeconds))
    if (intervalSeconds !== value.intervalSeconds) void save({ ...value, intervalSeconds })
  }

  return (
    <div className="card">
      <h2 className="settings-section-title">{t('settings.startupArtwork.title')}</h2>
      <fieldset className="startup-artwork-modes" disabled={busy} aria-label={t('settings.startupArtwork.title')}>
        {(['default', 'library', 'custom'] as const).map((mode) => (
          <label key={mode}>
            <input type="radio" name="startup-artwork-mode" value={mode} checked={value.mode === mode}
              onChange={() => void save({ ...value, mode })} />
            <span>{t(`settings.startupArtwork.${mode}`)}</span>
          </label>
        ))}
      </fieldset>
      <div className="startup-artwork-settings">
        <img
          className="startup-artwork-preview"
          src={preview}
          alt={t('settings.startupArtwork.preview')}
          onError={() => setPreview(defaultArtwork)}
        />
        <div className="startup-artwork-options">
          <p className="settings-hint">
            {t(`settings.startupArtwork.${value.mode}Hint`, { seconds: value.intervalSeconds })}
          </p>
          {value.mode === 'library' && (
            <label className="startup-artwork-interval">
              <span>{t('settings.startupArtwork.interval')}</span>
              <input
                className="settings-input"
                type="number"
                min={1}
                max={60}
                step={1}
                value={intervalText}
                disabled={busy}
                onChange={(event) => setIntervalText(event.target.value)}
                onBlur={saveInterval}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur()
                }}
              />
              <span>{t('settings.startupArtwork.seconds')}</span>
            </label>
          )}
          {value.mode === 'custom' && (
            <>
              <div className="startup-artwork-path" title={value.customPath}>
                {value.customPath || t('settings.startupArtwork.noFile')}
              </div>
              <button className="ghost" disabled={busy} onClick={() => void browse()}>
                {t('settings.startupArtwork.choose')}
              </button>
            </>
          )}
          <p className="settings-hint">{t('settings.startupArtwork.nextStart')}</p>
          {error && <p className="error-banner">{error}</p>}
        </div>
      </div>
      {value.mode === 'library' && (
        <StartupArtworkSources value={value} libraryId={libraryId} disabled={busy} onChange={save} />
      )}
    </div>
  )
}
