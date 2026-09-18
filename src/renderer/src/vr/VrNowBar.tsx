import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown,
  ChevronUp,
  ListMusic,
  ListOrdered,
  Pause,
  Play,
  Repeat,
  Shuffle,
  SkipBack,
  SkipForward
} from 'lucide-react'
import type { MediaListItem } from '@shared/schemas/media-index'
import type { QueueState } from '@shared/schemas/queue'
import CachedIpcImage, { thumbCache } from '../ipcImage'
import { ipcInvoke, ipcOn } from '../ipc'
import { clockDuration, displayTitle } from './format'

/**
 * How often the player is read while something plays. Often enough for the
 * playhead to move smoothly and to notice HereSphere pausing on its own.
 */
const TICK_MS = 500

/** A drag along the seek bar does not need to fire a seek per frame. */
const SEEK_THROTTLE_MS = 60

/** How near the player has to land before the head stops following the drag. */
const SCRUB_SETTLE_MS = 900

/** ... and how long to wait for it to land at all, if it never does. */
const SCRUB_HOLD_MS = 2500

/**
 * The strip along the foot of the panel: what is playing, the transport, and
 * the way to the queue and the playlists — with the seek bar under it.
 *
 * Skipping plays into HereSphere like everything else on the panel. It is
 * steering what is already being watched, so it never puts the panel away.
 *
 * The seek bar is the funscript heatmap, so the interesting part of the scene
 * can be seen before the laser drags to it. Folded, it stays as a thin strip
 * that still shows where playback is but takes no clicks: a target a few
 * pixels high is not one a laser a metre away can hit.
 */
export default function VrNowBar({
  queueOpen,
  onQueue,
  onPlaylists,
  seekBarOpen,
  onToggleSeekBar,
  onError
}: {
  queueOpen: boolean
  onQueue: () => void
  onPlaylists: () => void
  seekBarOpen: boolean
  onToggleSeekBar: () => void
  onError: (e: unknown) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [playing, setPlaying] = useState<{ libraryId: string; mediaId: string } | null>(null)
  const [paused, setPaused] = useState<boolean | null>(null)
  const [position, setPosition] = useState<{ ms: number | null; total: number | null }>({
    ms: null,
    total: null
  })
  const [row, setRow] = useState<MediaListItem | null>(null)
  const [heatmap, setHeatmap] = useState<string | null>(null)
  const [queue, setQueue] = useState<QueueState | null>(null)
  /**
   * Where the laser put the playhead, shown until the player reports having
   * arrived there. Without it the head springs back to where the video still
   * is on every read and fights the drag.
   */
  const [scrubMs, setScrubMs] = useState<number | null>(null)
  const scrub = useRef<{ target: number | null; dragging: boolean; sentAt: number }>({
    target: null,
    dragging: false,
    sentAt: 0
  })

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
        setPosition({ ms: s.positionMs, total: s.durationMs })
        // Hand the head back to the player once it has caught up with where it
        // was dropped — or given up on getting there.
        const target = scrub.current.target
        if (target === null || scrub.current.dragging) return
        const there = s.positionMs !== null && Math.abs(s.positionMs - target) < SCRUB_SETTLE_MS
        if (there || Date.now() - scrub.current.sentAt > SCRUB_HOLD_MS) {
          scrub.current.target = null
          setScrubMs(null)
        }
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
      setHeatmap(null)
      return
    }
    let alive = true
    ipcInvoke('media:listByIds', { targets: [playing] })
      .then(({ items }) => alive && setRow(items[0] ?? null))
      .catch(() => {})
    ipcInvoke('media:getHeatmap', playing)
      .then(({ dataUrl }) => alive && setHeatmap(dataUrl))
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
  const total = position.total ?? row?.durationMs ?? null
  // The dragged position wins over the read one, for the head and the clock.
  const shownMs = playing ? (scrubMs ?? position.ms) : null
  const progress = total && shownMs !== null ? Math.min(1, Math.max(0, shownMs / total)) : 0
  const canSeek = playing !== null && !!total

  /**
   * Follow the laser along the track. `settle` sends the seek whatever the
   * throttle says, so where the trigger is let go is where the video lands.
   */
  const scrubTo = (e: React.PointerEvent<HTMLDivElement>, settle: boolean): void => {
    if (!canSeek || !total) return
    const box = e.currentTarget.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width))
    const ms = ratio * total
    scrub.current.target = ms
    setScrubMs(ms)
    const now = Date.now()
    if (!settle && now - scrub.current.sentAt < SEEK_THROTTLE_MS) return
    scrub.current.sentAt = now
    ipcInvoke('playback:seek', { positionMs: ms }).catch(onError)
  }

  const startScrub = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!canSeek) return
    // Captured, so the drag carries on when the laser wanders off the track.
    e.currentTarget.setPointerCapture(e.pointerId)
    scrub.current.dragging = true
    scrubTo(e, true)
  }

  const endScrub = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!scrub.current.dragging) return
    scrub.current.dragging = false
    scrubTo(e, true)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  const track = (
    <>
      {heatmap ? (
        <img className="vr-seek-heat" src={heatmap} alt="" draggable={false} />
      ) : (
        <span className="vr-seek-plain" />
      )}
      <i className="vr-seek-fill" style={{ right: `${(1 - progress) * 100}%` }} />
      {playing && <b className="vr-seek-head" style={{ left: `${progress * 100}%` }} />}
    </>
  )

  return (
    <>
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
          <button
            className="vr-now-square"
            aria-label={t(seekBarOpen ? 'vr.hideSeekBar' : 'vr.showSeekBar')}
            aria-pressed={seekBarOpen}
            onClick={onToggleSeekBar}
          >
            {seekBarOpen ? <ChevronDown size={28} /> : <ChevronUp size={28} />}
          </button>
        </div>
      </footer>

      {seekBarOpen ? (
        <div className="vr-seek">
          <span className="vr-seek-time">{formatSpan(shownMs)}</span>
          <div
            className={`vr-seek-track${canSeek ? '' : ' idle'}`}
            onPointerDown={startScrub}
            onPointerMove={(e) => scrub.current.dragging && scrubTo(e, false)}
            onPointerUp={endScrub}
            onPointerCancel={endScrub}
          >
            {track}
          </div>
          <span className="vr-seek-time">{formatSpan(playing ? total : null)}</span>
          <button className="vr-icon-btn" aria-label={t('vr.hideSeekBar')} onClick={onToggleSeekBar}>
            <ChevronDown size={28} />
          </button>
        </div>
      ) : (
        <div className="vr-seek-thin">{track}</div>
      )}
    </>
  )
}

/** A clock for the seek bar: dashes with nothing to time, 0:00 at the start. */
function formatSpan(ms: number | null): string {
  if (ms === null || ms < 0) return '--:--'
  return clockDuration(ms) ?? '0:00'
}
