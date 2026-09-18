import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ListMusic, ListOrdered, Pause, Play, Repeat, Shuffle, SkipBack, SkipForward } from 'lucide-react'
import type { MediaListItem } from '@shared/schemas/media-index'
import type { QueueState } from '@shared/schemas/queue'
import CachedIpcImage, { thumbCache } from '../ipcImage'
import { ipcInvoke, ipcOn } from '../ipc'
import { displayTitle } from './format'

/** How often the play/pause state is read while something plays; HereSphere pauses on its own. */
const TICK_MS = 1000

/**
 * The strip along the foot of the panel: what is playing, the transport, and
 * the way to the queue and the playlists.
 *
 * Skipping plays into HereSphere like everything else on the panel. It is
 * steering what is already being watched, so it never puts the panel away.
 */
export default function VrNowBar({
  queueOpen,
  onQueue,
  onPlaylists,
  onError
}: {
  queueOpen: boolean
  onQueue: () => void
  onPlaylists: () => void
  onError: (e: unknown) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [playing, setPlaying] = useState<{ libraryId: string; mediaId: string } | null>(null)
  const [paused, setPaused] = useState<boolean | null>(null)
  const [row, setRow] = useState<MediaListItem | null>(null)
  const [queue, setQueue] = useState<QueueState | null>(null)

  const read = useCallback((): void => {
    ipcInvoke('playback:status')
      .then((s) => {
        setPlaying((current) =>
          s.mediaId && s.libraryId
            ? current?.mediaId === s.mediaId
              ? current
              : { libraryId: s.libraryId, mediaId: s.mediaId }
            : null
        )
        setPaused(s.paused)
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    read()
    ipcInvoke('queue:get').then(setQueue).catch(() => {})
    const offPlay = ipcOn('event:playback-changed', read)
    const offQueue = ipcOn('event:queue-changed', setQueue)
    return () => {
      offPlay()
      offQueue()
    }
  }, [read])

  useEffect(() => {
    if (!playing) return
    const timer = setInterval(read, TICK_MS)
    return () => clearInterval(timer)
  }, [playing, read])

  useEffect(() => {
    if (!playing) {
      setRow(null)
      return
    }
    let alive = true
    ipcInvoke('media:listByIds', { targets: [playing] })
      .then(({ items }) => alive && setRow(items[0] ?? null))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [playing])

  const step = (action: 'next' | 'previous' | 'resume'): void => {
    ipcInvoke('vr:queue', { action }).catch(onError)
  }

  const playPause = (): void => {
    if (!playing) {
      step('resume')
      return
    }
    ipcInvoke('playback:setPaused', { paused: !paused })
      .then(() => setPaused(!paused))
      .catch(onError)
  }

  const queued = queue?.items.length ?? 0
  const canSkip = queued > 0

  return (
    <footer className="vr-nowbar">
      <div className="vr-now">
        <span className="vr-now-thumb">
          {playing && (
            <CachedIpcImage
              className="vr-cover-img"
              cache={thumbCache}
              channel="media:getThumbnail"
              libraryId={playing.libraryId}
              mediaId={playing.mediaId}
            />
          )}
        </span>
        <span className={`vr-now-title${playing ? '' : ' idle'}`}>
          {playing ? (row ? displayTitle(row) : '') : t('nowplaying.idle')}
        </span>
      </div>

      <div className="vr-transport">
        <button
          className={queue?.shuffle ? 'on' : ''}
          aria-label={t('playlist.shuffle')}
          aria-pressed={queue?.shuffle ?? false}
          onClick={() => ipcInvoke('queue:setMode', { shuffle: !queue?.shuffle }).catch(onError)}
        >
          <Shuffle size={26} />
        </button>
        <button aria-label={t('nowplaying.previous')} disabled={!canSkip} onClick={() => step('previous')}>
          <SkipBack size={28} />
        </button>
        <button
          className="vr-transport-main"
          aria-label={t(playing && !paused ? 'vr.pause' : 'vr.play')}
          disabled={!playing && !canSkip}
          onClick={playPause}
        >
          {playing && !paused ? <Pause size={32} /> : <Play size={32} />}
        </button>
        <button aria-label={t('nowplaying.next')} disabled={!canSkip} onClick={() => step('next')}>
          <SkipForward size={28} />
        </button>
        <button
          className={queue?.repeat ? 'on' : ''}
          aria-label={t('playlist.repeat')}
          aria-pressed={queue?.repeat ?? false}
          onClick={() => ipcInvoke('queue:setMode', { repeat: !queue?.repeat }).catch(onError)}
        >
          <Repeat size={26} />
        </button>
      </div>

      <div className="vr-now-lists">
        <button className={queueOpen ? 'on' : ''} aria-pressed={queueOpen} onClick={onQueue}>
          <ListOrdered size={24} />
          {t('vr.queue')}
          {queued > 0 && <span className="vr-count">{queued}</span>}
        </button>
        <button onClick={onPlaylists}>
          <ListMusic size={24} />
          {t('playlist.title')}
        </button>
      </div>
    </footer>
  )
}
