import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AppWindow,
  Captions,
  Check,
  Expand,
  FolderOpen,
  Frame,
  Loader2,
  PictureInPicture2,
  Shrink,
  SlidersHorizontal,
  SquareArrowOutUpRight,
  Glasses,
  RotateCcw,
  Volume2,
  VolumeX,
  X
} from 'lucide-react'
import type {
  InternalPlayerIntent,
  InternalPlayerReport,
  SubtitleTrack,
  VideoRoute,
  VideoRouteFallback
} from '@shared/schemas/playback'
import type { VrLayout, VrProjection } from '@shared/schemas/vr-video'
import { VR_LAYOUTS, VR_PROJECTIONS } from '@shared/schemas/vr-video'
import {
  DEFAULT_VR_FORMAT,
  FLAT_VR_FORMAT,
  isVrFormat,
  vrProjectionShape
} from '@shared/vr-video'
import { ipcInvoke, ipcOn } from '../ipc'
import { mediaFileUrl } from '../mediaUrl'
import { languageName } from '../languageName'
import { StreamFeed } from '../streamFeed'
import { useErrorMessage } from '../useErrorMessage'
import { useMainWindowOpen } from '../useMainWindow'
import { DEFAULT_VR_LOOK, VR_FOV_MAX, VR_FOV_MIN, VR_PITCH_LIMIT, type VrLook } from '../vrView'
import ContextMenu, { type MenuItem } from './ContextMenu'
import NowPlayingBar from './NowPlayingBar'
import SubtitleLayer, { type SubtitleLook } from './SubtitleLayer'
import SubtitleSettings from './SubtitleSettings'
import VrSurface from './VrSurface'

/**
 * The built-in picture.
 *
 * Deliberately without controls. Play, pause, seek, volume and what plays next
 * all live on the now-playing bar at the foot of the window, which is there on
 * every page already — a second set of the same controls over the video would
 * be two things to keep in step and one more question ("which one counts?")
 * than the app needs. The only chrome here is the strip that moves the picture
 * between its three shapes.
 *
 * What the picture does carry is gestures, which are not a second set of
 * controls but the ones every video anywhere answers to: click to pause, wheel
 * for volume, double click for full screen, right click for the menu. They go
 * out through `playback:*` like the bar's buttons do, so the bar, the playback
 * clock and the device all stay on the same answer.
 *
 * The element does not decide anything: it matches the intent the main process
 * publishes and reports what it sees. That is what lets it be destroyed and
 * rebuilt — filling the page, floating, or in a window of its own — without
 * playback noticing.
 */

/** How the picture sits in the main window. Its own window is neither. */
export type StageForm = 'fill' | 'float'

/** Position reports. Four a second is what `timeupdate` gives, and the
 *  playback clock extrapolates between them anyway. */
const REPORT_MS = 250

/** One wheel notch. Twenty from silence to full is fine enough to land on. */
const VOLUME_STEP = 5

/** How long the volume stays on screen after the last notch. */
const VOLUME_SHOWN_MS = 900

/** A dragged slider is not worth a settings file write per frame. */
const LOOK_SAVE_MS = 300

/** What one step of the subtitle nudge is worth, in seconds. */
const NUDGES = [-0.5, -0.1, 0.1, 0.5]

/** A load or seek quicker than this shows no spinner rather than a flicker. */
const SPINNER_DELAY_MS = 300

/** One wheel notch of field of view, in degrees. */
const FOV_STEP = 5

/**
 * How far the pointer may move during a press and still be a click.
 *
 * Turning a VR picture and pausing it are the same button, so a hand that
 * shifts by a pixel or two on the way up must not stop the video.
 */
const DRAG_SLOP = 4

/**
 * Whether this machine decodes HEVC. It depends on the graphics hardware, and
 * a file the picture could take as it is would otherwise be converted.
 */
function canDecodeHevc(): boolean {
  try {
    return MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"')
  } catch {
    return false
  }
}

/** Why there is nothing on the picture, when there is nothing on it. */
type Trouble = 'unsupported' | 'needs_ffmpeg'

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

/**
 * Keep the view inside the part of the sphere the file holds. A whole sphere
 * has no edge to stop at and carries on round; half of one stops where the
 * picture does, rather than letting the viewer turn into the black.
 */
function clampLook(look: VrLook, projection: VrProjection): VrLook {
  const shape = vrProjectionShape(projection)
  const half = shape ? shape.fovDeg / 2 : 0
  const yaw = half >= 180 ? ((((look.yaw + 180) % 360) + 360) % 360) - 180 : clamp(look.yaw, -half, half)
  return {
    yaw,
    pitch: clamp(look.pitch, -Math.min(VR_PITCH_LIMIT, half), Math.min(VR_PITCH_LIMIT, half)),
    fov: clamp(look.fov, VR_FOV_MIN, VR_FOV_MAX)
  }
}

export default function VideoPlayerStage({
  intent,
  form,
  onForm,
  onClose,
  detached = false,
  tucked = false,
  z,
  onRaise,
  onFullscreenChange
}: {
  intent: InternalPlayerIntent
  form: StageForm
  onForm: (form: StageForm) => void
  /** Undefined in the detached window: its own title bar closes it. */
  onClose?: () => void
  detached?: boolean
  /**
   * Out of sight, still playing (`playback.keepPlayingWhenClosed`).
   *
   * Hidden rather than unmounted, and the difference is the whole point of the
   * setting: an unmounted element takes the sound with it, which is exactly
   * what the user asked not to happen.
   */
  tucked?: boolean
  /**
   * Where it sits in the app's panel stacking, which is a record of what the
   * user touched last rather than a fixed order. Pressing play therefore puts
   * the picture in front of the detail panel it was pressed from, and opening
   * the script player afterwards puts that in front of the picture.
   *
   * Absent in the picture's own window: nothing to stack against there.
   */
  z?: number
  onRaise?: () => void
  /** Full screen is the element's, so only it knows; the app asks. */
  onFullscreenChange?: (fullscreen: boolean) => void
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const toMessage = useErrorMessage()
  /** With the main window closed, this window is the way back to the app. */
  const mainWindowOpen = useMainWindowOpen()
  const video = useRef<HTMLVideoElement | null>(null)
  const shell = useRef<HTMLDivElement | null>(null)
  const [trouble, setTrouble] = useState<Trouble | null>(null)
  /** Loading or seeking for long enough to say so. */
  const [waiting, setWaiting] = useState(false)
  /** Installing ffmpeg from the picture: null, or the percentage so far (-1 = unknown). */
  const [installing, setInstalling] = useState<number | null>(null)
  const [installError, setInstallError] = useState<string | null>(null)
  /** How the current file was loaded — what a failure falls back from. */
  const loaded = useRef<VideoRoute | null>(null)
  const feed = useRef<StreamFeed | null>(null)
  /** Bumped by every load, so a route answered for an older one is dropped. */
  const loadTurn = useRef(0)
  /**
   * The load whose file is on the element. While it lags `loadTurn` a new
   * route is still being worked out, and a failure reported in that gap is
   * the old one's — falling back from it again would skip a step.
   */
  const settledTurn = useRef(0)
  const pausedNow = useRef(intent.paused)
  pausedNow.current = intent.paused
  /** Where the app last asked the picture to be, in milliseconds. */
  const askedMs = useRef(intent.seekMs)
  const [fullscreen, setFullscreen] = useState(false)
  /** Where the floating picture has been dragged to, in pixels from top-left. */
  const [spot, setSpot] = useState<{ x: number; y: number } | null>(null)
  const drag = useRef<{ dx: number; dy: number } | null>(null)
  /** The seek we have already carried out, so one request is obeyed once. */
  const seenSeek = useRef(intent.seekToken)
  const path = intent.media?.path ?? null
  /** The area that answers to the pointer; the picture minus its overlays. */
  const gestures = useRef<HTMLDivElement | null>(null)
  /** How the subtitle looks. Null until the settings have been read. */
  const [look, setLook] = useState<SubtitleLook | null>(null)
  const saveLook = useRef<number | undefined>(undefined)
  /** Where the viewer is facing in a VR file, and how wide a view. */
  const [vrLook, setVrLook] = useState<VrLook>(DEFAULT_VR_LOOK)
  /** No canvas to be had on this machine: show the file as it is stored. */
  const [vrBroken, setVrBroken] = useState(false)
  const vrOn = isVrFormat(intent.vr) && !vrBroken
  /** A press being turned into a turn, and whether it has moved enough yet. */
  const turningView = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  /** The press just finished turned the picture, so its click is not a pause. */
  const turned = useRef(false)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  /** What this video offers. Null while we are still finding out. */
  const [tracks, setTracks] = useState<SubtitleTrack[] | null>(null)
  /** The level a wheel notch just asked for, shown for a moment on the picture. */
  const [volumeShown, setVolumeShown] = useState<number | null>(null)
  const volumeTimer = useRef<number | undefined>(undefined)
  /**
   * Where the wheel has got to, ahead of the player confirming it.
   *
   * Notches arrive faster than the intent comes back, so reading the level off
   * the intent each time makes ten notches worth one step.
   */
  const turning = useRef<number | null>(null)
  /**
   * The chosen subtitle, held steady while it is the same one.
   *
   * Every intent event arrives as a fresh object, and they arrive on every
   * pause and every wheel notch. Handed straight down, that would be a fresh
   * subtitle to the layer each time — and a re-read of the file behind it.
   */
  const subtitleId = intent.subtitle?.id ?? null
  const subtitle = useMemo(() => intent.subtitle, [subtitleId])

  // Claim the surface for this window: the main process sends the intent to
  // every window, but only the one holding the picture is the player.
  useEffect(() => {
    void ipcInvoke('video:claim', { surface: detached ? 'window' : 'docked' }).catch(() => {})
    return () => {
      void ipcInvoke('video:release').catch(() => {})
    }
  }, [detached])

  const report = useCallback(
    (extra: { ended?: boolean; error?: InternalPlayerReport['error'] }): void => {
      const el = video.current
      void ipcInvoke('video:report', {
        path,
        positionMs: el && Number.isFinite(el.currentTime) ? el.currentTime * 1000 : null,
        durationMs: el && Number.isFinite(el.duration) ? el.duration * 1000 : null,
        paused: el ? el.paused : true,
        volume: el ? Math.round(el.volume * 100) : 100,
        ended: extra.ended ?? false,
        error: extra.error ?? null
      }).catch(() => {})
    },
    [path]
  )

  const fail = useCallback(
    (why: Trouble): void => {
      feed.current?.dispose()
      feed.current = null
      const el = video.current
      if (el) {
        el.removeAttribute('src')
        el.load()
      }
      setTrouble(why)
      report({ error: why === 'needs_ffmpeg' ? 'needs_ffmpeg' : 'unsupported_format' })
    },
    [report]
  )

  /**
   * Put the file on the picture, the way the main process says it plays.
   *
   * `atS` null means wherever the app last asked for, read once the route is
   * known — a seek made while it was being worked out is not lost.
   */
  const load = useCallback(
    async (fallback: VideoRouteFallback, atS: number | null): Promise<void> => {
      const el = video.current
      if (!el || !path) return
      const turn = ++loadTurn.current
      feed.current?.dispose()
      feed.current = null
      setTrouble(null)
      let route: VideoRoute
      try {
        route = await ipcInvoke('video:route', { path, hevc: canDecodeHevc(), fallback })
      } catch {
        if (turn === loadTurn.current) fail('unsupported')
        return
      }
      if (turn !== loadTurn.current) return
      loaded.current = route
      settledTurn.current = turn
      const at = atS ?? askedMs.current / 1000

      if (route.kind === 'needs_ffmpeg') {
        fail('needs_ffmpeg')
        return
      }
      if (route.kind === 'direct') {
        // Asked for something other than the file as it is, and still told to
        // play it as it is: nothing is left to try.
        if (fallback !== 'none') {
          fail('unsupported')
          return
        }
        el.src = mediaFileUrl(path)
        el.currentTime = at
      } else {
        const next: StreamFeed = new StreamFeed(el, path, route, () => {
          if (feed.current === next) fallBack.current()
        })
        feed.current = next
        next.start(at)
      }
      if (!pausedNow.current) void el.play().catch(() => {})
    },
    [fail, path]
  )

  /**
   * The route tried did not play: try the next one down. The file as it is,
   * then its tracks moved into a container Chromium opens, then converted.
   * Chromium does not say *why* it will not play something, so each step is
   * simply the next thing that might.
   */
  const fallBack = useRef<() => void>(() => {})
  fallBack.current = (): void => {
    if (settledTurn.current !== loadTurn.current) return
    const route = loaded.current
    const el = video.current
    const at = el && Number.isFinite(el.currentTime) ? el.currentTime : null
    if (route?.kind === 'direct') void load('stream', at)
    else if (route?.kind === 'stream' && (route.video === 'copy' || route.audio === 'copy')) {
      void load('encode', at)
    } else fail('unsupported')
  }

  // Load whatever the intent names. Changing `src` resets the element, so this
  // runs on the media alone — every other field is handled without a reload.
  useEffect(() => {
    const el = video.current
    if (!el) return
    seenSeek.current = intent.seekToken
    askedMs.current = intent.seekMs
    loaded.current = null
    feed.current?.dispose()
    feed.current = null
    setTrouble(null)
    setInstallError(null)
    // A new file is faced from the front, and gets its own try at a canvas.
    setVrLook(DEFAULT_VR_LOOK)
    setVrBroken(false)
    el.removeAttribute('src')
    el.load()
    if (!intent.media) {
      loadTurn.current++
      return
    }
    void load('none', null)
    // Keyed on the file alone: a new position for one already loaded is a
    // seek, which the effect below does without throwing the buffer away.
  }, [path])

  useEffect(() => () => feed.current?.dispose(), [])

  useEffect(() => {
    const el = video.current
    if (!el || intent.seekToken === seenSeek.current) return
    seenSeek.current = intent.seekToken
    askedMs.current = intent.seekMs
    // A stream follows the element's seek on its own, starting ffmpeg again
    // when the position is not buffered.
    el.currentTime = intent.seekMs / 1000
  }, [intent.seekToken, intent.seekMs])

  useEffect(() => {
    const el = video.current
    if (!el || !intent.media) return
    if (intent.paused) el.pause()
    // A play() rejected because the file cannot be decoded is reported by the
    // error handler below; nothing to say here.
    else void el.play().catch(() => {})
  }, [intent.paused, intent.media])

  useEffect(() => {
    const el = video.current
    if (el) el.volume = Math.min(1, Math.max(0, intent.volume / 100))
  }, [intent.volume])

  // Report position, and the two things only the element knows: how long the
  // file is, and whether it ran out.
  useEffect(() => {
    const timer = setInterval(() => report({}), REPORT_MS)
    const el = video.current
    const onEnded = (): void => report({ ended: true })
    const onError = (): void => {
      // An element with nothing loaded has nothing to fail at.
      if (loaded.current) fallBack.current()
    }
    el?.addEventListener('ended', onEnded)
    el?.addEventListener('error', onError)
    return () => {
      clearInterval(timer)
      el?.removeEventListener('ended', onEnded)
      el?.removeEventListener('error', onError)
    }
  }, [report])

  // The spinner: shown while the element is waiting for data, whether that is
  // a first load, a seek, or a converted stream catching up.
  useEffect(() => {
    const el = video.current
    if (!el) return
    let timer: number | undefined
    const busy = (): void => {
      if (timer === undefined) timer = window.setTimeout(() => setWaiting(true), SPINNER_DELAY_MS)
    }
    const ready = (): void => {
      window.clearTimeout(timer)
      timer = undefined
      setWaiting(false)
    }
    const busyOn = ['loadstart', 'waiting', 'seeking']
    const readyOn = ['loadeddata', 'canplay', 'playing', 'seeked', 'error', 'emptied']
    for (const name of busyOn) el.addEventListener(name, busy)
    for (const name of readyOn) el.addEventListener(name, ready)
    return () => {
      window.clearTimeout(timer)
      for (const name of busyOn) el.removeEventListener(name, busy)
      for (const name of readyOn) el.removeEventListener(name, ready)
    }
  }, [])

  // Installing ffmpeg from the picture, then trying the file again.
  useEffect(
    () =>
      ipcOn('event:dep-progress', (progress) => {
        if (progress.id !== 'ffmpeg') return
        const { bytesDownloaded, totalBytes } = progress
        setInstalling((cur) =>
          cur === null ? cur : totalBytes ? Math.floor((bytesDownloaded / totalBytes) * 100) : -1
        )
      }),
    []
  )

  const installFfmpeg = useCallback(async (): Promise<void> => {
    setInstalling(-1)
    setInstallError(null)
    try {
      await ipcInvoke('deps:install', { id: 'ffmpeg' })
      setInstalling(null)
      void load('none', null)
    } catch (e) {
      setInstalling(null)
      setInstallError(toMessage(e))
    }
  }, [load, toMessage])

  // Full screen belongs to whichever window the picture is in, so it is the
  // browser's own: in the main window it covers the app, in the detached
  // window it covers that window.
  useEffect(() => {
    const onChange = (): void => {
      const on = document.fullscreenElement !== null
      setFullscreen(on)
      onFullscreenChange?.(on)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [onFullscreenChange])

  const toggleFullscreen = useCallback((): void => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else void shell.current?.requestFullscreen().catch(() => {})
  }, [])

  // How the subtitle looks is one setting for the whole app, so it is read
  // here and written back here; the picture's own window reads the same one.
  useEffect(() => {
    ipcInvoke('settings:get')
      .then((settings) => setLook(settings.playback.subtitles))
      .catch(() => {})
  }, [])

  const changeLook = useCallback((next: SubtitleLook): void => {
    setLook(next)
    window.clearTimeout(saveLook.current)
    saveLook.current = window.setTimeout(() => {
      void ipcInvoke('settings:update', { playback: { subtitles: next } }).catch(() => {})
    }, LOOK_SAVE_MS)
  }, [])

  const togglePaused = useCallback((): void => {
    void ipcInvoke('playback:setPaused', { paused: !intent.paused }).catch(() => {})
  }, [intent.paused])

  const onVrUnavailable = useCallback((): void => setVrBroken(true), [])

  /** Change how this file is marked; stored in its sidecar. */
  const setVr = useCallback((patch: { projection?: VrProjection; layout?: VrLayout }): void => {
    void ipcInvoke('video:setVr', patch).catch(() => {})
  }, [])

  /**
   * Turning a VR picture: the pointer drags the scene along with it.
   *
   * A press is only a turn once it has moved; until then it is on its way to
   * being the click that pauses, which is the same button on the same layer.
   */
  const startTurn = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (!vrOn || event.button !== 0) return
    turningView.current = { x: event.clientX, y: event.clientY, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const turnView = (event: React.PointerEvent<HTMLDivElement>): void => {
    const held = turningView.current
    if (!held) return
    const dx = event.clientX - held.x
    const dy = event.clientY - held.y
    if (!held.moved && Math.hypot(dx, dy) < DRAG_SLOP) return
    held.moved = true
    held.x = event.clientX
    held.y = event.clientY
    // A pixel is worth the angle it covers, so the same drag turns further
    // when the view is wide and less when it is zoomed in.
    const perPixel = vrLook.fov / Math.max(1, event.currentTarget.clientHeight)
    setVrLook((now) =>
      clampLook(
        { ...now, yaw: now.yaw + dx * perPixel, pitch: now.pitch + dy * perPixel },
        intent.vr.projection
      )
    )
  }

  const endTurn = (event: React.PointerEvent<HTMLDivElement>): void => {
    const held = turningView.current
    turningView.current = null
    turned.current = held?.moved ?? false
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const onPictureClick = (): void => {
    // The press that turned the picture ends in a click here; it has already
    // done its job.
    if (turned.current) {
      turned.current = false
      return
    }
    togglePaused()
  }

  /**
   * The wheel, on the element rather than through React.
   *
   * React listens for wheel passively, which means `preventDefault` there does
   * nothing — and without it, turning the volume down over a floating picture
   * also scrolls the library behind it.
   */
  useEffect(() => {
    const el = gestures.current
    if (!el) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      // Ctrl and the wheel is the field of view; the wheel alone is the volume.
      if (vrOn && event.ctrlKey) {
        setVrLook((now) =>
          clampLook(
            { ...now, fov: now.fov + (event.deltaY < 0 ? -FOV_STEP : FOV_STEP) },
            intent.vr.projection
          )
        )
        return
      }
      const from = turning.current ?? intent.volume
      const next = Math.min(100, Math.max(0, from + (event.deltaY < 0 ? VOLUME_STEP : -VOLUME_STEP)))
      turning.current = next
      setVolumeShown(next)
      window.clearTimeout(volumeTimer.current)
      volumeTimer.current = window.setTimeout(() => setVolumeShown(null), VOLUME_SHOWN_MS)
      if (next === intent.volume) return
      void ipcInvoke('playback:setVolume', { volume: next }).catch(() => {})
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [intent.volume, intent.vr.projection, vrOn])

  // Caught up: the next notch can start from the intent again.
  useEffect(() => {
    if (turning.current === intent.volume) turning.current = null
  }, [intent.volume])

  useEffect(() => {
    return () => {
      window.clearTimeout(volumeTimer.current)
      window.clearTimeout(saveLook.current)
    }
  }, [])

  /** What this video offers, asked for when the menu opens and not before. */
  const openMenu = useCallback(
    (event: React.MouseEvent): void => {
      event.preventDefault()
      setMenuAt({ x: event.clientX, y: event.clientY })
      // Nothing loaded: an empty list, not a search that never ends.
      if (!path) {
        setTracks([])
        return
      }
      setTracks(null)
      ipcInvoke('video:subtitleTracks', { path })
        .then((result) => setTracks(result.tracks))
        .catch(() => setTracks([]))
    },
    [path]
  )

  const chooseTrack = useCallback((track: SubtitleTrack | null): void => {
    void ipcInvoke('video:setSubtitle', { track }).catch(() => {})
  }, [])

  const nudge = useCallback((offsetMs: number): void => {
    void ipcInvoke('video:setSubtitleOffset', { offsetMs }).catch(() => {})
  }, [])

  const menuItems = useMemo((): MenuItem[] => {
    const current = intent.subtitle
    const items: MenuItem[] = [
      {
        key: 'off',
        label: t('player.subtitles.off'),
        icon: current === null ? <Check size={13} /> : undefined,
        onPick: () => chooseTrack(null)
      }
    ]
    if (tracks === null) {
      items.push({ key: 'searching', label: t('player.subtitles.searching'), disabled: true })
    } else {
      for (const track of tracks) {
        // The label is the code only when the file carried nothing better to
        // call it; a stream's own title is left as its author wrote it.
        const named =
          track.language && track.label === track.language
            ? languageName(track.language, i18n.language)
            : null
        items.push({
          key: track.id,
          label: named ?? track.label,
          icon: current?.id === track.id ? <Check size={13} /> : undefined,
          hint: track.origin === 'embedded' ? t('player.subtitles.embedded') : undefined,
          onPick: () => chooseTrack(track)
        })
      }
    }
    items.push({
      key: 'pick',
      label: t('player.subtitles.fromFile'),
      icon: <FolderOpen size={13} />,
      onPick: () => {
        void ipcInvoke('video:pickSubtitleFile')
          .then((result) => {
            if (result.track) chooseTrack(result.track)
          })
          .catch(() => {})
      }
    })
    items.push({
      key: 'delay',
      label: t('player.subtitles.delay'),
      icon: <Captions size={13} />,
      hint: `${(intent.subtitleOffsetMs / 1000).toFixed(1)}s`,
      disabled: current === null,
      children: [
        ...NUDGES.map((step) => ({
          key: `nudge${step}`,
          label: step > 0 ? `+${step}s` : `${step}s`,
          onPick: () => nudge(intent.subtitleOffsetMs + Math.round(step * 1000))
        })),
        { key: 'reset', label: t('player.subtitles.resetDelay'), onPick: () => nudge(0) }
      ]
    })
    items.push({
      key: 'look',
      label: t('player.subtitles.settings'),
      icon: <SlidersHorizontal size={13} />,
      onPick: () => setPanelOpen(true)
    })
    items.push({
      key: 'vr',
      label: t('player.vr.title'),
      icon: <Glasses size={13} />,
      hint: isVrFormat(intent.vr) ? t(`player.vr.projections.${intent.vr.projection}`) : undefined,
      children: [
        {
          key: 'projection',
          label: t('player.vr.projection'),
          children: VR_PROJECTIONS.map((projection) => ({
            key: projection,
            label: t(`player.vr.projections.${projection}`),
            icon: intent.vr.projection === projection ? <Check size={13} /> : undefined,
            // Leaving flat takes the usual eye layout with it; flat itself
            // has one picture and no second eye.
            onPick: () =>
              setVr(
                projection === 'flat'
                  ? FLAT_VR_FORMAT
                  : isVrFormat(intent.vr)
                    ? { projection }
                    : { projection, layout: DEFAULT_VR_FORMAT.layout }
              )
          }))
        },
        {
          key: 'layout',
          label: t('player.vr.layout'),
          disabled: !isVrFormat(intent.vr),
          children: [
            ...VR_LAYOUTS.map((layout) => ({
              key: layout,
              label: t(`player.vr.layouts.${layout}`),
              icon: intent.vr.layout === layout ? <Check size={13} /> : undefined,
              onPick: () => setVr({ layout })
            }))
          ]
        },
        {
          key: 'recentre',
          label: t('player.vr.recentre'),
          icon: <RotateCcw size={13} />,
          disabled: !vrOn,
          onPick: () => setVrLook(DEFAULT_VR_LOOK)
        }
      ]
    })
    return items
  }, [
    chooseTrack,
    i18n.language,
    intent.subtitle,
    intent.subtitleOffsetMs,
    intent.vr,
    nudge,
    setVr,
    t,
    tracks,
    vrOn
  ])

  /**
   * Dragging the floating picture around.
   *
   * Clamped to the area it lives in, and there is nothing beyond that edge:
   * it is an element in this window, so it cannot leave it, and being dragged
   * to the edge does not turn it into a separate window either. The button for
   * that is right there, and a shape change nobody asked for is worse than a
   * drag that stops.
   */
  const startDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (form !== 'float' || event.button !== 0) return
    // Not on the buttons. Capturing the pointer sends the matching pointerup
    // to this bar rather than to whatever was pressed, and a press with no
    // release on the same element never becomes a click — which is how
    // dragging silently killed all four buttons.
    if ((event.target as HTMLElement).closest('button')) return
    const box = shell.current?.getBoundingClientRect()
    if (!box) return
    drag.current = { dx: event.clientX - box.left, dy: event.clientY - box.top }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const held = drag.current
    const box = shell.current?.getBoundingClientRect()
    const area = shell.current?.offsetParent?.getBoundingClientRect()
    if (!held || !box || !area) return
    const x = event.clientX - area.left - held.dx
    const y = event.clientY - area.top - held.dy
    setSpot({
      x: Math.min(Math.max(0, x), Math.max(0, area.width - box.width)),
      y: Math.min(Math.max(0, y), Math.max(0, area.height - box.height))
    })
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const title = intent.media?.fileName ?? ''

  return (
    <div
      className={`video-stage ${detached ? 'window' : form}${fullscreen ? ' fullscreen' : ''}${
        tucked ? ' tucked' : ''
      }`}
      ref={shell}
      style={{
        ...(z === undefined ? {} : { zIndex: z }),
        ...(form === 'float' && !detached && spot
          ? { left: spot.x, top: spot.y, right: 'auto', bottom: 'auto' }
          : {})
      }}
      onPointerDown={onRaise}
    >
      <div
        className="video-bar"
        onPointerDown={startDrag}
        onPointerMove={onDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className="video-title" title={title}>
          {title}
        </span>
        <span className="grow" />
        {!detached && (
          <button
            className="video-btn"
            title={t(form === 'fill' ? 'player.shrink' : 'player.expand')}
            onClick={() => onForm(form === 'fill' ? 'float' : 'fill')}
          >
            {form === 'fill' ? <PictureInPicture2 size={14} /> : <Frame size={14} />}
          </button>
        )}
        {detached && !mainWindowOpen && (
          <button
            className="video-btn"
            title={t('common.showMainWindow')}
            onClick={() => void ipcInvoke('app:showMainWindow').catch(() => {})}
          >
            <AppWindow size={14} />
          </button>
        )}
        <button
          className="video-btn"
          title={t(detached ? 'player.dock' : 'player.popOut')}
          onClick={() => void ipcInvoke(detached ? 'video:attach' : 'video:detach').catch(() => {})}
        >
          <SquareArrowOutUpRight size={14} className={detached ? 'flip' : undefined} />
        </button>
        <button
          className="video-btn"
          title={t(fullscreen ? 'player.exitFullscreen' : 'player.fullscreen')}
          onClick={toggleFullscreen}
        >
          {fullscreen ? <Shrink size={14} /> : <Expand size={14} />}
        </button>
        {onClose && (
          <button className="video-btn close" title={t('common.close')} onClick={onClose}>
            <X size={14} />
          </button>
        )}
      </div>

      <div className="video-picture">
        {/*
          Muted is never set: this player's volume is the one on the bar.
          `crossOrigin` lets WebGL read the frames of a VR file; without it the
          media scheme counts as another origin and the upload is refused.
        */}
        <video ref={video} playsInline crossOrigin="anonymous" />
        {vrOn && (
          <VrSurface
            video={video}
            format={intent.vr}
            look={vrLook}
            onUnavailable={onVrUnavailable}
          />
        )}
        {/*
          The gestures sit on their own layer under everything else in here, so
          the subtitle, the message and the full-screen bar are not in the way
          of a click meant for the video — and a click on one of them is not a
          pause nobody asked for.
        */}
        <div
          ref={gestures}
          className={`video-gestures${vrOn ? ' turnable' : ''}`}
          onClick={onPictureClick}
          onDoubleClick={toggleFullscreen}
          onContextMenu={openMenu}
          onPointerDown={startTurn}
          onPointerMove={turnView}
          onPointerUp={endTurn}
          onPointerCancel={endTurn}
        />
        {look && (
          <SubtitleLayer
            video={video}
            track={subtitle}
            offsetMs={intent.subtitleOffsetMs}
            look={look}
          />
        )}
        {volumeShown !== null && (
          <div className="video-volume">
            {volumeShown === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
            <span>{volumeShown}</span>
          </div>
        )}
        {look && panelOpen && (
          <SubtitleSettings
            look={look}
            onLook={changeLook}
            offsetMs={intent.subtitleOffsetMs}
            onOffset={nudge}
            onClose={() => setPanelOpen(false)}
          />
        )}
        {waiting && !trouble && (
          <div className="video-loading">
            <Loader2 size={30} className="spin" />
          </div>
        )}
        {trouble === 'unsupported' && <p className="video-failed">{t('player.unsupported')}</p>}
        {trouble === 'needs_ffmpeg' && (
          <div className="video-failed needs-ffmpeg">
            <p>{t('player.needsFfmpeg')}</p>
            <button
              className="primary"
              disabled={installing !== null}
              onClick={() => void installFfmpeg()}
            >
              {installing === null ? (
                t('player.installFfmpeg')
              ) : (
                <>
                  <Loader2 size={13} className="spin" />
                  {t('player.installingFfmpeg')}
                  {installing >= 0 && <span className="video-install-progress">{installing}%</span>}
                </>
              )}
            </button>
            {installError && <p className="video-install-error">{installError}</p>}
          </div>
        )}
        {/*
          The one place controls have to sit on the picture. Full screen takes
          the bar at the foot of the window with it, so the same bar comes
          along — not a second set of controls, the same component.
        */}
        {fullscreen && (
          <div className="video-osd">
            <NowPlayingBar variant="detached" />
          </div>
        )}
      </div>

      {/*
        Drawn inside the picture's own shell rather than on the page. Full
        screen paints that shell and nothing else, and the menu is most wanted
        exactly there — a subtitle that is too small is a full-screen problem.
      */}
      {menuAt && (
        <ContextMenu
          x={menuAt.x}
          y={menuAt.y}
          items={menuItems}
          container={shell.current}
          onClose={() => setMenuAt(null)}
        />
      )}
    </div>
  )
}

/**
 * What the main process wants the picture to be showing.
 *
 * Read once and then followed, because events only carry changes: a window
 * opened while something is already playing has missed every one of them.
 */
export function useVideoIntent(): InternalPlayerIntent | null {
  const [intent, setIntent] = useState<InternalPlayerIntent | null>(null)
  useEffect(() => {
    let live = true
    ipcInvoke('video:intent')
      .then((current) => {
        // A change that arrived while this was in flight is the newer answer.
        if (live) setIntent((known) => known ?? current)
      })
      .catch(() => {})
    const off = ipcOn('event:video-intent', setIntent)
    return () => {
      live = false
      off()
    }
  }, [])
  return intent
}
