import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, ListStart, Save, Trash2, Volume2, X } from 'lucide-react'
import { Virtuoso } from 'react-virtuoso'
import type { MediaListItem } from '@shared/schemas/media-index'
import type { QueueState } from '@shared/schemas/queue'
import CachedIpcImage, { thumbCache } from '../ipcImage'
import { ipcInvoke, ipcOn } from '../ipc'
import { clockDuration, displayTitle } from './format'

/** A second press on "clear" within this long empties the queue. */
const CONFIRM_MS = 3000

/**
 * The queue, edited with buttons rather than by dragging: a laser a metre away
 * cannot drop a row between two others with any precision.
 */
export default function VrQueue({
  onPlay,
  onSaved,
  onError
}: {
  onPlay: (item: { libraryId: string; mediaId: string }) => void
  onSaved: (message: string) => void
  onError: (error: unknown) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [saving, setSaving] = useState(false)
  const [state, setState] = useState<QueueState | null>(null)
  const [rows, setRows] = useState<Map<string, MediaListItem>>(new Map())
  const [playing, setPlaying] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    ipcInvoke('queue:get')
      .then(setState)
      .catch(() => {})
    ipcInvoke('playback:status')
      .then((status) => setPlaying(status.mediaId))
      .catch(() => {})
    const offQueue = ipcOn('event:queue-changed', setState)
    const offPlaying = ipcOn('event:playback-changed', ({ mediaId }) => setPlaying(mediaId))
    return () => {
      offQueue()
      offPlaying()
    }
  }, [])

  // Titles for the ids the queue holds, fetched for the ones not yet known.
  useEffect(() => {
    if (!state) return
    const unknown = state.items.filter((item) => !rows.has(item.mediaId))
    if (unknown.length === 0) return
    ipcInvoke('media:listByIds', { targets: unknown })
      .then(({ items }) =>
        setRows((current) => {
          const next = new Map(current)
          for (const item of items) next.set(item.id, item)
          return next
        })
      )
      .catch(() => {})
  }, [state, rows])

  const run = (call: Promise<unknown>): void => {
    call.catch(onError)
  }

  if (!state || state.items.length === 0) {
    return <div className="vr-empty">{t('vr.queueEmpty')}</div>
  }

  const items = state.items
  const cursor = state.index >= 0 ? items[state.index] : undefined

  const clear = (): void => {
    if (!confirmClear) {
      setConfirmClear(true)
      if (confirmTimer.current) clearTimeout(confirmTimer.current)
      confirmTimer.current = setTimeout(() => setConfirmClear(false), CONFIRM_MS)
      return
    }
    setConfirmClear(false)
    run(ipcInvoke('queue:clear'))
  }

  return (
    <div className="vr-queue">
      <div className="vr-queue-head">
        <span className="grow">{t('vr.queueCount', { count: items.length })}</span>
        <button className="vr-danger" onClick={() => setSaving(true)}>
          <Save size={24} />
          {t('queue.save')}
        </button>
        <button className={`vr-danger${confirmClear ? ' armed' : ''}`} onClick={clear}>
          <Trash2 size={24} />
          {t(confirmClear ? 'vr.clearConfirm' : 'vr.clearQueue')}
        </button>
      </div>
      {saving && (
        <SaveAsPlaylist
          onClose={() => setSaving(false)}
          onSaved={(name, count) => {
            setSaving(false)
            onSaved(t('queue.saved', { count, name }))
          }}
          onError={onError}
        />
      )}
      <Virtuoso
        className="vr-scroll"
        data={items}
        increaseViewportBy={{ top: 200, bottom: 600 }}
        computeItemKey={(_, item) => item.mediaId}
        itemContent={(i, item) => {
          const row = rows.get(item.mediaId)
          const isPlaying = item.mediaId === playing
          const isNext = cursor !== undefined && items[state.index + 1]?.mediaId === item.mediaId
          return (
            <div className={`vr-qrow${isPlaying ? ' playing' : ''}`}>
              <button className="vr-qrow-main" onClick={() => onPlay(item)}>
                <span className="vr-qrow-index">{isPlaying ? <Volume2 size={24} /> : i + 1}</span>
                <span className="vr-qrow-thumb">
                  <CachedIpcImage
                    className="vr-cover-img"
                    cache={thumbCache}
                    channel="media:getThumbnail"
                    libraryId={item.libraryId}
                    mediaId={item.mediaId}
                  />
                </span>
                <span className="vr-qrow-title">{row ? displayTitle(row) : t('vr.unknownVideo')}</span>
                <span className="vr-qrow-time">{row ? clockDuration(row.durationMs) : null}</span>
              </button>
              <div className="vr-qrow-tools">
                <button
                  aria-label={t('vr.moveUp')}
                  disabled={i === 0}
                  onClick={() =>
                    run(ipcInvoke('queue:move', { mediaId: item.mediaId, afterMediaId: i >= 2 ? items[i - 2]!.mediaId : null }))
                  }
                >
                  <ArrowUp size={26} />
                </button>
                <button
                  aria-label={t('vr.moveDown')}
                  disabled={i === items.length - 1}
                  onClick={() => run(ipcInvoke('queue:move', { mediaId: item.mediaId, afterMediaId: items[i + 1]!.mediaId }))}
                >
                  <ArrowDown size={26} />
                </button>
                <button
                  aria-label={t('vr.playNext')}
                  disabled={isPlaying || isNext || item.mediaId === cursor?.mediaId}
                  onClick={() =>
                    run(ipcInvoke('queue:move', { mediaId: item.mediaId, afterMediaId: cursor?.mediaId ?? null }))
                  }
                >
                  <ListStart size={26} />
                </button>
                <button
                  aria-label={t('vr.remove')}
                  onClick={() => run(ipcInvoke('queue:remove', { items: [item] }))}
                >
                  <Trash2 size={26} />
                </button>
              </div>
            </div>
          )
        }}
      />
    </div>
  )
}

/**
 * Names the playlist the queue is kept as. The field takes focus on opening,
 * which brings up the headset keyboard.
 */
function SaveAsPlaylist({
  onClose,
  onSaved,
  onError
}: {
  onClose: () => void
  onSaved: (name: string, count: number) => void
  onError: (error: unknown) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [name, setName] = useState('')

  const save = (): void => {
    const trimmed = name.trim()
    if (!trimmed) return
    ipcInvoke('queue:saveAsPlaylist', { name: trimmed })
      .then((result) => onSaved(result.name, result.added))
      .catch(onError)
  }

  return (
    <div className="vr-sheet" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="vr-sheet-card vr-name-card"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <header className="vr-sheet-head">
          <h2>{t('queue.save')}</h2>
          <button type="button" className="vr-icon-btn" aria-label={t('vr.close')} onClick={onClose}>
            <X size={28} />
          </button>
        </header>
        <input
          className="vr-name-input"
          autoFocus
          value={name}
          placeholder={t('queue.savePrompt')}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" className="vr-primary-inline" disabled={!name.trim()}>
          <Save size={26} />
          {t('queue.save')}
        </button>
      </form>
    </div>
  )
}
