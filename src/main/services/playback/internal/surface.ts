import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import type { InternalPlayerIntent, InternalPlayerReport } from '@shared/schemas/playback'

/**
 * Where the built-in picture is, and what it is meant to be showing.
 *
 * The picture is a `<video>` element in a renderer, so unlike every other
 * player this one lives on the far side of an IPC boundary and can be
 * destroyed and rebuilt while playback continues — that is exactly what
 * happens when the user pops it out into its own window.
 *
 * So this module holds a *state*, not a queue of commands. The surface reads
 * it on mount and matches it; a rebuilt surface therefore lands where the old
 * one was without anything being replayed. Commands would have to be buffered,
 * de-duplicated and re-sent, and would still lose a seek that arrived while no
 * surface existed.
 */

const IDLE_INTENT: InternalPlayerIntent = {
  active: false,
  media: null,
  seekToken: 0,
  seekMs: 0,
  paused: true,
  volume: 100,
  subtitle: null,
  subtitleOffsetMs: 0
}

interface SurfaceEvents {
  /** The intent changed and every window should hear about it. */
  intent: (intent: InternalPlayerIntent) => void
  /** The surface said where it is; several times a second while playing. */
  report: (report: InternalPlayerReport) => void
  /** The surface went away — unmounted, or its window closed. */
  lost: () => void
}

class TypedEmitter extends EventEmitter {
  override on<K extends keyof SurfaceEvents>(e: K, l: SurfaceEvents[K]): this {
    return super.on(e, l)
  }
  override emit<K extends keyof SurfaceEvents>(e: K, ...args: Parameters<SurfaceEvents[K]>): boolean {
    return super.emit(e, ...args)
  }
}

export const videoSurfaceEvents = new TypedEmitter()

let intent: InternalPlayerIntent = IDLE_INTENT
let holder: WebContents | null = null
/** Cleans up the `destroyed` listener when the surface is handed on. */
let dropHolder: (() => void) | null = null
let losing: NodeJS.Timeout | null = null

/**
 * How long the picture may be nowhere before the player is considered gone.
 *
 * Moving the picture between the main window and its own window means the old
 * element unmounts before the new one mounts, so there is always a gap with no
 * surface at all. Without this grace period every move would look like the
 * player disconnecting and reconnecting — the video would stop and the source
 * list would blink through an error on a perfectly ordinary drag-out.
 */
const HANDOVER_GRACE_MS = 1500

function scheduleLoss(): void {
  if (losing) clearTimeout(losing)
  losing = setTimeout(() => {
    losing = null
    if (hasVideoSurface()) return
    videoSurfaceEvents.emit('lost')
  }, HANDOVER_GRACE_MS)
}

function cancelLoss(): void {
  if (!losing) return
  clearTimeout(losing)
  losing = null
}

export function videoIntent(): InternalPlayerIntent {
  return intent
}

export function hasVideoSurface(): boolean {
  return holder !== null && !holder.isDestroyed()
}

/** Change part of the intent and tell the windows. Unchanged fields are kept. */
export function setVideoIntent(patch: Partial<InternalPlayerIntent>): InternalPlayerIntent {
  intent = { ...intent, ...patch }
  videoSurfaceEvents.emit('intent', intent)
  return intent
}

/** Ask for a position. A token rather than a level — see the schema. */
export function requestVideoSeek(positionMs: number): void {
  setVideoIntent({ seekToken: intent.seekToken + 1, seekMs: Math.max(0, positionMs) })
}

export function resetVideoIntent(): void {
  intent = { ...IDLE_INTENT, seekToken: intent.seekToken }
  videoSurfaceEvents.emit('intent', intent)
}

/**
 * This window is drawing the picture now.
 *
 * Only one at a time: docking out replaces the main window's surface with the
 * new window's, and the old one is told nothing because it is unmounting
 * anyway. A window that vanishes without releasing — closed, crashed — is
 * caught by the `destroyed` listener, which is the case that matters: the
 * player must not go on believing it has a picture.
 */
export function claimVideoSurface(contents: WebContents): InternalPlayerIntent {
  cancelLoss()
  if (holder === contents) return intent
  dropHolder?.()
  holder = contents
  const onDestroyed = (): void => {
    if (holder !== contents) return
    holder = null
    dropHolder = null
    scheduleLoss()
  }
  contents.once('destroyed', onDestroyed)
  dropHolder = () => contents.off('destroyed', onDestroyed)
  return intent
}

export function releaseVideoSurface(contents: WebContents): void {
  if (holder !== contents) return
  dropHolder?.()
  dropHolder = null
  holder = null
  scheduleLoss()
}

export function reportVideoState(report: InternalPlayerReport): void {
  videoSurfaceEvents.emit('report', report)
}

/**
 * Wait for a surface to appear, having just asked for one.
 *
 * Pressing play with the picture closed has to open it and then load into it,
 * and the window needs a moment to mount. Bounded, because "no window ever
 * answered" has to become a player error rather than a play that never
 * resolves.
 */
export function waitForVideoSurface(timeoutMs: number): Promise<boolean> {
  cancelLoss()
  if (hasVideoSurface()) return Promise.resolve(true)
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    // Not unref'd: this is being awaited. A timer that lets the loop go idle
    // is a wait that never ends when there is nothing else going on.
    const tick = setInterval(() => {
      if (hasVideoSurface()) {
        clearInterval(tick)
        resolve(true)
      } else if (Date.now() >= deadline) {
        clearInterval(tick)
        resolve(false)
      }
    }, 60)
  })
}
