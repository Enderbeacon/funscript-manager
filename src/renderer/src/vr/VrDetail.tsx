import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ListEnd, ListStart, Play, RefreshCw, X } from 'lucide-react'
import type { MediaDetail, MediaListItem } from '@shared/schemas/media-index'
import { SCRIPT_AXIS_KEYS } from '@shared/schemas/media-meta'
import CachedIpcImage, { thumbCache } from '../ipcImage'
import { ipcInvoke, ipcOn } from '../ipc'
import { clockDuration, displayTitle } from './format'

interface Playing {
  mediaId: string | null
  scriptVersionId: string | null
}

/**
 * One video, in a column beside the grid: look at it, choose which script
 * plays with it, then play it or queue it.
 *
 * With the video already playing, choosing another script and pressing the
 * main button swaps the script in and carries on from the same moment.
 */
export default function VrDetail({
  item,
  onClose,
  onPlay,
  onQueue
}: {
  item: MediaListItem
  onClose: () => void
  /** Resolves with the script version that was loaded, or null on failure. */
  onPlay: (scriptVersionId: string | undefined, resume: boolean) => Promise<string | null | undefined>
  onQueue: (mode: 'next' | 'end') => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [detail, setDetail] = useState<MediaDetail | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [playing, setPlaying] = useState<Playing>({ mediaId: null, scriptVersionId: null })

  useEffect(() => {
    let alive = true
    setDetail(null)
    ipcInvoke('media:get', { libraryId: item.libraryId, mediaId: item.id })
      .then((d) => {
        if (!alive || !d) return
        setDetail(d)
        // The one a plain play would pick: last used, then the default, then the first.
        const versions = d.scriptVersions
        const pick =
          versions.find((v) => v.id === d.lastUsedScriptVersionId) ??
          versions.find((v) => v.isDefault) ??
          versions[0]
        setSelected(pick?.id ?? null)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [item.libraryId, item.id])

  useEffect(() => {
    const read = (): void => {
      ipcInvoke('playback:status')
        .then((s) => setPlaying({ mediaId: s.mediaId, scriptVersionId: s.scriptVersionId }))
        .catch(() => {})
    }
    read()
    return ipcOn('event:playback-changed', read)
  }, [])

  const versions = detail?.scriptVersions ?? []
  const isPlaying = playing.mediaId === item.id
  const switching = isPlaying && selected !== null && selected !== playing.scriptVersionId

  const main = async (): Promise<void> => {
    const loaded = await onPlay(selected ?? undefined, switching)
    if (loaded !== undefined) setPlaying({ mediaId: item.id, scriptVersionId: loaded })
  }

  const facts = [
    clockDuration(item.durationMs),
    item.scriptVersionCount === 0 ? t('vr.noScript') : t('vr.scripts', { count: item.scriptVersionCount }),
    item.hasMultiAxis ? t('vr.multiAxis') : null
  ].filter(Boolean)

  return (
    <aside className="vr-side">
      <div className="vr-side-head">
        <button className="vr-icon-btn" aria-label={t('vr.close')} onClick={onClose}>
          <X size={30} />
        </button>
      </div>

      <div className="vr-side-body">
        <div className="vr-side-cover">
          <CachedIpcImage
            className="vr-cover-img"
            cache={thumbCache}
            channel="media:getThumbnail"
            libraryId={item.libraryId}
            mediaId={item.id}
          />
        </div>
        <h2 className="vr-side-title">{displayTitle(item)}</h2>
        <p className="vr-facts">{facts.join(' · ')}</p>

        {versions.length > 0 && (
          <>
            <h3 className="vr-side-label">{t('vr.script')}</h3>
            <div className="vr-versions">
              {versions.map((v) => {
                const on = v.id === selected
                // Axes as badges, as on the desktop: solid is the version's
                // own, outlined is borrowed from the default multi-axis one.
                const borrowed = new Set(v.borrowedAxes)
                const shown = new Set([...v.axes, ...v.borrowedAxes])
                const axes = SCRIPT_AXIS_KEYS.filter((axis) => shown.has(axis))
                return (
                  <button
                    key={v.id}
                    className={`vr-version${on ? ' on' : ''}`}
                    aria-pressed={on}
                    onClick={() => setSelected(v.id)}
                  >
                    <span className="vr-version-top">
                      <span className={`vr-radio${on ? ' on' : ''}`} />
                      <span className="vr-version-name">{v.name}</span>
                      {isPlaying && v.id === playing.scriptVersionId && (
                        <span className="vr-version-now">{t('vr.nowPlaying')}</span>
                      )}
                    </span>
                    <span className="vr-version-meta">
                      {v.author && v.author !== v.name && <span className="vr-version-author">{v.author}</span>}
                      {v.isDefault && <span className="vr-flag">{t('detail.default')}</span>}
                      {!v.isDefault && v.id === detail?.lastUsedScriptVersionId && (
                        <span className="vr-flag">{t('detail.lastUsed')}</span>
                      )}
                      <span className="vr-axes">
                        {axes.map((axis) => (
                          <span key={axis} className={`vr-ax${borrowed.has(axis) ? ' borrowed' : ''}`}>
                            {axis === 'main' ? 'M' : axis[0]!.toUpperCase()}
                          </span>
                        ))}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </>
        )}

        {item.tags.length > 0 && (
          <div className="vr-side-tags">
            {item.tags.map((tag) => (
              <span key={tag} className="vr-chip vr-chip-static">
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="vr-side-actions">
        <button className="vr-primary" onClick={() => void main()}>
          {switching ? <RefreshCw size={28} /> : <Play size={28} />}
          {t(switching ? 'vr.switchScript' : 'vr.play')}
        </button>
        <div className="vr-side-pair">
          <button onClick={() => onQueue('next')}>
            <ListStart size={24} />
            {t('vr.playNext')}
          </button>
          <button onClick={() => onQueue('end')}>
            <ListEnd size={24} />
            {t('vr.addToEnd')}
          </button>
        </div>
      </div>
    </aside>
  )
}
