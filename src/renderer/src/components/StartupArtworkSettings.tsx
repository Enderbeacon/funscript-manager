import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Settings } from '@shared/schemas/app-config'
import { ipcInvoke, ipcOn } from '../ipc'
import { useErrorMessage } from '../useErrorMessage'
import defaultArtwork from '../assets/brand/startup-artwork.svg'
import StartupArtworkSources from './StartupArtworkSources'

type Artwork = Settings['ui']['startupArtwork']

interface CacheStatus {
  running: boolean
  processed: number
  total: number
  ready: number
  stored: number
  removable: number
}

const EMPTY_CACHE_STATUS: CacheStatus = {
  running: false,
  processed: 0,
  total: 0,
  ready: 0,
  stored: 0,
  removable: 0
}

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
  const [cacheBusy, setCacheBusy] = useState(false)
  const [cacheStatus, setCacheStatus] = useState<CacheStatus>(EMPTY_CACHE_STATUS)
  const [error, setError] = useState<string | null>(null)
  const [intervalText, setIntervalText] = useState(String(value.intervalSeconds))
  const previewKey = JSON.stringify(value)

  useEffect(() => setIntervalText(String(value.intervalSeconds)), [value.intervalSeconds])

  useEffect(() => {
    let cancelled = false
    const load = (): void => {
      if (value.mode === 'default') {
        setPreview(defaultArtwork)
        return
      }
      void ipcInvoke('app:startupArtwork', { purpose: 'settings' }).then(({ images }) => {
        if (!cancelled) setPreview(images[0] ?? defaultArtwork)
      }).catch(() => {})
    }
    setPreview(defaultArtwork)
    load()
    const off = ipcOn('event:startup-artwork-ready', () => load())
    return () => {
      cancelled = true
      off()
    }
  }, [previewKey, libraryId])

  useEffect(() => {
    if (value.mode !== 'library') return
    let cancelled = false
    const refresh = (): void => {
      void ipcInvoke('app:startupArtworkCacheStatus').then((status) => {
        if (!cancelled) setCacheStatus(status)
      }).catch(() => {})
    }
    refresh()
    const off = ipcOn('event:startup-artwork-cache', (progress) => {
      if (cancelled) return
      setCacheStatus((current) => ({ ...current, ...progress }))
      if (!progress.running) refresh()
    })
    return () => {
      cancelled = true
      off()
    }
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

  const clearUnusedCache = async (): Promise<void> => {
    setCacheBusy(true)
    setError(null)
    try {
      setCacheStatus(await ipcInvoke('app:startupArtworkClearUnused'))
    } catch (e) {
      setError(toMessage(e))
    } finally {
      setCacheBusy(false)
    }
  }

  const presentation = value.mode === 'library'
    ? value.libraryPresentation
    : value.mode === 'custom'
      ? value.customPresentation
      : 'cover'

  const setPresentation = (next: 'cover' | 'framed'): void => {
    if (value.mode === 'library') void save({ ...value, libraryPresentation: next })
    if (value.mode === 'custom') void save({ ...value, customPresentation: next })
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
        <div className={`startup-artwork-preview ${presentation === 'framed' ? 'framed' : ''}`}>
          {presentation === 'framed' && (
            <img className="startup-artwork-preview-backdrop" src={preview} alt="" />
          )}
          <img
            className="startup-artwork-preview-image"
            src={preview}
            alt={t('settings.startupArtwork.preview')}
            onError={() => setPreview(defaultArtwork)}
          />
        </div>
        <div className="startup-artwork-options">
          <p className="settings-hint">
            {t(`settings.startupArtwork.${value.mode}Hint`, { seconds: value.intervalSeconds })}
          </p>
          {value.mode !== 'default' && (
            <div className="startup-artwork-presentation">
              <span>{t('settings.startupArtwork.presentation')}</span>
              <div className="startup-artwork-presentation-options">
                {(['cover', 'framed'] as const).map((option) => (
                  <button
                    type="button"
                    className={presentation === option ? 'active' : ''}
                    disabled={busy}
                    aria-pressed={presentation === option}
                    onClick={() => setPresentation(option)}
                    key={option}
                  >
                    {t(`settings.startupArtwork.${option}`)}
                  </button>
                ))}
              </div>
            </div>
          )}
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
          {value.mode === 'library' && (
            <div className="startup-artwork-cache-status">
              <div className="startup-artwork-cache-head">
                <span>
                  {cacheStatus.running
                    ? cacheStatus.total > 0
                      ? t('settings.startupArtwork.cacheProgress', {
                          processed: cacheStatus.processed,
                          total: cacheStatus.total,
                          ready: cacheStatus.ready
                        })
                      : t('settings.startupArtwork.cachePreparing')
                    : t('settings.startupArtwork.cacheStored', { count: cacheStatus.stored })}
                </span>
                <button
                  type="button"
                  className="ghost"
                  disabled={busy || cacheBusy || cacheStatus.running || cacheStatus.removable === 0}
                  onClick={() => void clearUnusedCache()}
                >
                  {t('settings.startupArtwork.cacheClear', { count: cacheStatus.removable })}
                </button>
              </div>
              {cacheStatus.running && (
                <progress
                  max={Math.max(cacheStatus.total, 1)}
                  value={cacheStatus.processed}
                />
              )}
            </div>
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
