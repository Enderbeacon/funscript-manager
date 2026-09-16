import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ChevronUp,
  ListVideo,
  Pause,
  Play,
  Repeat,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX
} from 'lucide-react'
import type { MediaSelection } from '../App'
import type { MediaDetail } from '@shared/schemas/media-index'
import type { QueueState } from '@shared/schemas/queue'
import type { IpcOutput } from '@shared/ipc/contract'
import { ipcInvoke, ipcOn } from '../ipc'
import { describeQueueSource } from '../queueSource'

type PlaybackStatus = IpcOutput<'playback:status'>

/**
 * What is playing, and what plays next.
 *
 * App-level, spanning the window under the nav rail, because playback outlives
 * the page that started it: the video keeps going while the user is on the
 * downloads page, so the control for it has to be somewhere that page still
 * has. Every music player puts it here for the same reason.
 *
 * It stays put with nothing playing, rather than vanishing. Volume, shuffle,
 * repeat and the queue are not properties of the current file — they are how
 * the next hour will go, and needing to start a video before you can turn the
 * volume down is the wrong way round.
 *
 * The scrubber is the funscript heatmap rather than a grey line. It is the one
 * thing this app can put there that a music player cannot — you can see where
 * the interesting part of the scene is before you drag to it.
 */

/** How often the position is re-read; the bar only has to look alive. */
const TICK_MS = 500

/** A drag across the scrubber does not need to fire a seek per frame. */
const SEEK_THROTTLE_MS = 60

/** How near the player has to land before the head stops following the drag. */
const SCRUB_SETTLE_MS = 900

/** ... and how long to wait for it to land at all, if it never does. */
const SCRUB_HOLD_MS = 2500

export default function NowPlayingBar({
  queueOpen = false,
  onToggleQueue,
  onOpenMedia,
  onArtwork,
  variant = 'app'
}: {
  queueOpen?: boolean
  /** Show the queue — or put it away again, if this is what opened it. */
  onToggleQueue?: () => void
  /** Open the detail view for what is playing. */
  onOpenMedia?: (selection: MediaSelection) => void
  /**
   * Something else for the artwork to do. The built-in picture uses it: with
   * the picture closed but the sound still going, the artwork is how it comes
   * back, which is more use right then than the detail view.
   */
  onArtwork?: (() => void) | null
  /**
   * `app` is the strip along the foot of the main window. `detached` is the
   * same controls inside the player's own window and over a full-screen
   * picture — no queue there, because the panel it opens is the main
   * window's.
   */
  variant?: 'app' | 'detached'
}): React.JSX.Element {
  const { t } = useTranslation()
  /**
   * What is playing, straight from the player.
   *
   * The library comes with it. The bar used to have to find that out from the
   * queue, which meant it went blank — no title, no artwork — whenever the two
   * disagreed for a moment, which is every time anything starts.
   */
  const [playing, setPlaying] = useState<MediaSelection | null>(null)
  const [row, setRow] = useState<MediaDetail | null>(null)
  const [thumb, setThumb] = useState<string | null>(null)
  const [heatmap, setHeatmap] = useState<string | null>(null)
  const [queue, setQueue] = useState<QueueState | null>(null)
  const [position, setPosition] = useState<{
    ms: number | null
    total: number | null
    paused: boolean | null
    volume: number | null
    /** What the player being followed can do; null when none is. */
    can: PlaybackStatus['capabilities']
  }>({ ms: null, total: null, paused: null, volume: null, can: null })
  /**
   * The volume being dragged, before the player has confirmed it. Without this
   * the slider snaps back to the last polled value between frames and fights
   * the pointer.
   */
  const [pendingVolume, setPendingVolume] = useState<number | null>(null)
  /**
   * Where the pointer put the playhead, shown until the player reports having
   * arrived there. The position is polled twice a second, so without this the
   * head springs back to where the video still is and fights the drag.
   */
  const [scrubMs, setScrubMs] = useState<number | null>(null)
  const scrub = useRef<{ target: number | null; dragging: boolean; sentAt: number }>({
    target: null,
    dragging: false,
    sentAt: 0
  })

  const readStatus = useCallback((): void => {
    ipcInvoke('playback:status')
      .then((s) => {
        setPlaying(
          s.mediaId && s.libraryId ? { libraryId: s.libraryId, mediaId: s.mediaId } : null
        )
        setPosition({
          ms: s.positionMs,
          total: s.durationMs,
          paused: s.paused,
          volume: s.volume,
          can: s.capabilities
        })
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
    readStatus()
    ipcInvoke('queue:get').then(setQueue).catch(() => {})
    const offPlay = ipcOn('event:playback-changed', () => readStatus())
    const offQueue = ipcOn('event:queue-changed', setQueue)
    return () => {
      offPlay()
      offQueue()
    }
  }, [readStatus])

  // The position moves on its own, so it is polled rather than pushed — an
  // event per frame would re-render the whole window several times a second.
  useEffect(() => {
    if (playing === null) return
    const timer = setInterval(readStatus, TICK_MS)
    return () => clearInterval(timer)
  }, [playing, readStatus])

  // The title, the artwork and the heatmap of what is playing.
  useEffect(() => {
    if (playing === null) {
      setRow(null)
      setThumb(null)
      setHeatmap(null)
      return
    }
    let alive = true
    ipcInvoke('media:get', playing)
      .then((detail) => alive && setRow(detail))
      .catch(() => {})
    ipcInvoke('media:getThumbnail', playing)
      .then(({ dataUrl }) => alive && setThumb(dataUrl))
      .catch(() => {})
    ipcInvoke('media:getHeatmap', playing)
      .then(({ dataUrl }) => alive && setHeatmap(dataUrl))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [playing?.libraryId, playing?.mediaId]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Where the queue's cursor is, so the neighbours can be named. */
  const at = queue
    ? queue.items.findIndex((item) => item.mediaId === playing?.mediaId)
    : -1
  const cursor = at >= 0 ? at : (queue?.index ?? -1)
  const neighbour = useCallback(
    (delta: number): { libraryId: string; mediaId: string } | null => {
      if (!queue || cursor < 0 || queue.items.length === 0) return null
      const next = (cursor + delta + queue.items.length) % queue.items.length
      return queue.items[next] ?? null
    },
    [queue, cursor]
  )

  const [prevTitle, setPrevTitle] = useState<string | null>(null)
  const [nextTitle, setNextTitle] = useState<string | null>(null)

  // Names for the two either side, which the skip buttons carry as their
  // tooltip. "Next" means nothing to a person until they can see what next is.
  useEffect(() => {
    let alive = true
    const around = [neighbour(-1), neighbour(1)]
    const targets = around.filter((n): n is MediaSelection => n !== null)
    if (targets.length === 0) {
      setPrevTitle(null)
      setNextTitle(null)
      return
    }
    ipcInvoke('media:listByIds', { targets })
      .then(({ items }) => {
        if (!alive) return
        const name = (target: MediaSelection | null): string | null => {
          if (!target) return null
          const found = items.find((item) => item.id === target.mediaId)
          return found ? (found.title || found.fileName) : null
        }
        setPrevTitle(name(around[0] ?? null))
        setNextTitle(name(around[1] ?? null))
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [neighbour])

  const idle = playing === null
  const total = position.total ?? row?.durationMs ?? null
  // The dragged position wins over the polled one, both for the head and for
  // the clock beside it.
  const shownMs = scrubMs ?? position.ms
  const progress = total && shownMs !== null ? Math.min(1, Math.max(0, shownMs / total)) : 0
  const title = row?.title || row?.fileName || ''
  const by = [row?.videoAuthors[0], row?.scriptAuthors[0]].filter(Boolean).join(' · ')
  const queued = queue?.items.length ?? 0

  /**
   * Follow the pointer along the track. `settle` sends the seek whatever the
   * throttle says, so the place the pointer was let go of is the place the
   * video ends up — a dropped last frame would leave it short of the mark.
   */
  const scrubTo = (e: React.PointerEvent<HTMLDivElement>, settle: boolean): void => {
    if (!total || idle) return
    const box = e.currentTarget.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width))
    const ms = ratio * total
    scrub.current.target = ms
    setScrubMs(ms)
    const now = Date.now()
    if (!settle && now - scrub.current.sentAt < SEEK_THROTTLE_MS) return
    scrub.current.sentAt = now
    void ipcInvoke('playback:seek', { positionMs: ms }).catch(() => {})
  }

  const startScrub = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!total || idle) return
    // Captured, so the drag carries on when the pointer leaves the 28 pixels
    // of the track — which it will, on a bar this thin.
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

  /** Play, pause — or, with nothing loaded, carry on where the queue left off. */
  const playPause = (): void => {
    if (idle) {
      void ipcInvoke('queue:resume').catch(() => {})
      return
    }
    void ipcInvoke('playback:setPaused', { paused: !position.paused }).catch(() => {})
  }

  return (
    <div className={`nowbar glass${idle ? ' idle' : ''}${variant === 'detached' ? ' detached' : ''}`}>
      <button
        className="np-art sfw"
        title={idle ? '' : t(onArtwork ? 'player.showPicture' : 'nowplaying.openDetail')}
        disabled={idle || (!onArtwork && !onOpenMedia)}
        onClick={() => {
          if (onArtwork) onArtwork()
          else if (playing) onOpenMedia?.(playing)
        }}
      >
        {thumb && <img className="np-thumb" src={thumb} alt="" draggable={false} />}
        {heatmap && <img className="np-heat" src={heatmap} alt="" draggable={false} />}
      </button>
      <div className="np-meta">
        <div className="np-title" title={title}>
          {idle ? t('nowplaying.idle') : title}
        </div>
        <div className="np-sub">{idle ? '' : by}</div>
      </div>

      <div className="np-mid">
        <div className="np-keys">
          <button
            className="np-k"
            title={prevTitle ?? t('nowplaying.previous')}
            disabled={queued === 0}
            onClick={() => void ipcInvoke('queue:previous').catch(() => {})}
          >
            <SkipBack size={13} fill="currentColor" />
          </button>
          <button
            className="np-k big"
            disabled={idle && queued === 0}
            title={idle ? t('nowplaying.resume') : ''}
            onClick={playPause}
          >
            {idle || position.paused ? <Play size={14} fill="currentColor" /> : <Pause size={14} />}
          </button>
          <button
            className="np-k"
            title={nextTitle ?? t('nowplaying.next')}
            disabled={queued === 0}
            onClick={() => void ipcInvoke('queue:next').catch(() => {})}
          >
            <SkipForward size={13} fill="currentColor" />
          </button>
        </div>
        <div className="np-seek">
          <span className="np-t">{formatSpan(shownMs)}</span>
          <div
            className="np-track"
            onPointerDown={startScrub}
            onPointerMove={(e) => scrub.current.dragging && scrubTo(e, false)}
            onPointerUp={endScrub}
            onPointerCancel={endScrub}
          >
            {heatmap ? (
              <img className="np-track-heat" src={heatmap} alt="" draggable={false} />
            ) : (
              <span className="np-track-plain" />
            )}
            <i className="np-fill" style={{ right: `${(1 - progress) * 100}%` }} />
            {!idle && <b className="np-head" style={{ left: `${progress * 100}%` }} />}
          </div>
          <span className="np-t">{formatSpan(total)}</span>
        </div>
      </div>

      <div className="np-right">
        <button
          className={`np-k${queue?.shuffle ? ' on' : ''}`}
          title={t('playlist.shuffle')}
          onClick={() => void ipcInvoke('queue:setMode', { shuffle: !queue?.shuffle }).catch(() => {})}
        >
          <Shuffle size={13} />
        </button>
        <button
          className={`np-k${queue?.repeat ? ' on' : ''}`}
          title={t('playlist.repeat')}
          onClick={() => void ipcInvoke('queue:setMode', { repeat: !queue?.repeat }).catch(() => {})}
        >
          <Repeat size={13} />
        </button>

        {/* The player's own volume, not a second one multiplied into it: two
            volumes that look the same is how people end up with silent
            playback and no idea which slider did it. A player that has no
            volume of its own — HereSphere's lives in the headset — gets no
            slider rather than one that does nothing. */}
        {position.can?.volume !== false && (
        <div className="np-vol">
          <button
            className="np-k"
            title={t('nowplaying.mute')}
            onClick={() => {
              const next = (pendingVolume ?? position.volume ?? 0) > 0 ? 0 : 100
              setPendingVolume(next)
              void ipcInvoke('playback:setVolume', { volume: next }).catch(() => {})
            }}
          >
            {(pendingVolume ?? position.volume ?? 0) > 0 ? <Volume2 size={13} /> : <VolumeX size={13} />}
          </button>
          <input
            className="np-vol-range"
            type="range"
            min={0}
            max={100}
            step={1}
            aria-label={t('nowplaying.volume')}
            value={pendingVolume ?? position.volume ?? 100}
            onChange={(e) => {
              const next = Number(e.target.value)
              setPendingVolume(next)
              void ipcInvoke('playback:setVolume', { volume: next }).catch(() => {})
            }}
            onPointerUp={() => setPendingVolume(null)}
          />
        </div>
        )}
        {variant === 'app' && (
        <button
          className={`np-queue${queueOpen ? ' on' : ''}`}
          aria-pressed={queueOpen}
          onClick={onToggleQueue}
        >
          <ListVideo size={13} />
          <span className="np-qname">{describeQueueSource(queue, t)}</span>
          {queued > 0 && (
            <span className="np-qn">
              {cursor >= 0 ? `${cursor + 1} / ${queued}` : queued}
            </span>
          )}
          <ChevronUp size={13} className={queueOpen ? 'np-qchev on' : 'np-qchev'} />
        </button>
        )}
      </div>
    </div>
  )
}

function formatSpan(ms: number | null): string {
  if (ms === null || ms < 0) return '--:--'
  const total = Math.round(ms / 1000)
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
