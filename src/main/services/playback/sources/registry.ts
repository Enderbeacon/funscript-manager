import { EventEmitter } from 'node:events'
import { AppError } from '@shared/errors'
import type { MediaSourceKind, MediaSourceProfile } from '@shared/schemas/app-config'
import type { MediaSourceState, MediaSourceStatus } from '@shared/schemas/playback'
import { createMediaSource } from './factory'
import type { MediaSourceAdapter, MediaSourceCapabilities, MediaSourceReading } from './port'
import { EMPTY_READING } from './port'

/**
 * The player list.
 *
 * Players are added by hand, the same way the script player's outputs are, but
 * only one of them is in use: the current player. Exactly one connection is
 * ever open, because two players on one video are two answers to "where are
 * we", and everything downstream — the bar, the script, the queue — would have
 * to pick one anyway.
 *
 * Choosing is therefore the only control there is. There is no connect button:
 * the current player is attached to whenever it is running, and pressing play
 * is what starts one that is not.
 */

export interface MediaSourceRegistryEvents {
  changed: (status: MediaSourceStatus[]) => void
  /** The current player moved to a different file (including one we did not open). */
  'path-changed': (p: { sourceId: string; path: string | null }) => void
  /** A file ran out on the current player. */
  ended: (p: { sourceId: string }) => void
}

interface Runtime {
  profile: MediaSourceProfile
  adapter: MediaSourceAdapter | null
  state: MediaSourceState
  error: MediaSourceStatus['error']
  /** Bumped on every connect/disconnect so a slow connect cannot land late. */
  generation: number
}

/**
 * How often an unreachable current player is tried again. This only ever
 * attaches — a background task that launches a video player is a window
 * appearing on the user's screen for no reason.
 */
const RETRY_MS = 5000
const RETRY_DELAY_MS = 1500

class TypedEmitter extends EventEmitter {
  override on<K extends keyof MediaSourceRegistryEvents>(
    e: K,
    l: MediaSourceRegistryEvents[K]
  ): this {
    return super.on(e, l)
  }
  override emit<K extends keyof MediaSourceRegistryEvents>(
    e: K,
    ...args: Parameters<MediaSourceRegistryEvents[K]>
  ): boolean {
    return super.emit(e, ...args)
  }
}

export const mediaSourceEvents = new TypedEmitter()

/** Insertion order is the user's order. */
const runtimes = new Map<string, Runtime>()
let currentId: string | null = null
let retryDelay: NodeJS.Timeout | null = null
let retryTimer: NodeJS.Timeout | null = null

/**
 * Take the saved list and which of them is in use.
 *
 * A player edited in a way its connection depends on is dropped first: pointed
 * at a new address it is a different player, and keeping the old socket would
 * show it as connected to something it is not.
 */
export function configureMediaSources(profiles: MediaSourceProfile[], current: string): void {
  const seen = new Set<string>()
  for (const profile of profiles) {
    seen.add(profile.id)
    const runtime = runtimes.get(profile.id)
    if (!runtime) {
      runtimes.set(profile.id, {
        profile,
        adapter: null,
        state: 'disconnected',
        error: null,
        generation: 0
      })
      continue
    }
    const moved =
      runtime.profile.kind !== profile.kind ||
      runtime.profile.host !== profile.host ||
      runtime.profile.port !== profile.port ||
      runtime.profile.exePath !== profile.exePath
    runtime.profile = profile
    if (moved && runtime.state !== 'disconnected') void disconnectSource(profile.id)
  }
  for (const [id] of runtimes) {
    if (!seen.has(id)) {
      void disconnectSource(id)
      runtimes.delete(id)
    }
  }
  // Keep the saved order, so the list reads the way the user arranged it.
  const ordered = profiles
    .map((profile) => [profile.id, runtimes.get(profile.id)!] as const)
    .filter(([, runtime]) => runtime !== undefined)
  runtimes.clear()
  for (const [id, runtime] of ordered) runtimes.set(id, runtime)

  // A current player that is no longer in the list, or none named at all,
  // falls back to the first one: there is nothing to play into without one.
  const resolved = runtimes.has(current) ? current : ([...runtimes.keys()][0] ?? null)
  if (resolved !== currentId) {
    void takeUp(resolved)
    return
  }
  for (const [id] of runtimes) if (id !== currentId) void disconnectSource(id)
  restartRetry()
  emitChanged()
}

/**
 * Switch to another player.
 *
 * The one being left is paused first, then let go of: a video still running in
 * a player nobody is watching is exactly what users complain about, and pausing
 * keeps its position for when they switch back. Whatever the new player is
 * already playing then becomes what the app is playing — following it is the
 * same path as the user opening a file in it by hand.
 */
export async function setCurrentSource(id: string): Promise<void> {
  if (!runtimes.has(id) || id === currentId) return
  await takeUp(id)
}

async function takeUp(id: string | null): Promise<void> {
  const previous = currentId === null ? null : runtimes.get(currentId)
  currentId = id
  emitChanged()
  if (previous) {
    if (previous.adapter?.capabilities.pause) {
      await previous.adapter.setPaused(true).catch(() => {})
    }
    await disconnectSource(previous.profile.id)
  }
  for (const [otherId] of runtimes) if (otherId !== id) void disconnectSource(otherId)
  restartRetry()
  if (id !== null) await connectSource(id, false).catch(() => {})
  emitChanged()
}

/**
 * Connect the current player. `launch` starts the program when it is one we can
 * start (mpv); only an explicit play does that.
 */
export async function connectCurrent(launch: boolean): Promise<void> {
  if (currentId === null) return
  await connectSource(currentId, launch)
}

async function connectSource(id: string, launch: boolean): Promise<void> {
  const runtime = runtimes.get(id)
  if (!runtime || runtime.state === 'connected' || runtime.state === 'connecting') return
  /*
   * There is nothing to attach to for the built-in picture: it exists only
   * while the user has one open, so "no picture" is its resting state rather
   * than a player that has gone missing and might come back. Trying anyway —
   * at startup, and every few seconds after — would leave its row painted as a
   * broken player instead of a closed one.
   */
  if (!launch && runtime.profile.kind === 'internal') return
  const generation = ++runtime.generation
  runtime.state = 'connecting'
  runtime.error = null
  emitChanged()
  try {
    const adapter = createMediaSource(runtime.profile)
    adapter.on('path-changed', ({ path }) => {
      if (generation !== runtime.generation || currentId !== id) return
      mediaSourceEvents.emit('path-changed', { sourceId: id, path })
      emitChanged()
    })
    adapter.on('ended', () => {
      if (generation !== runtime.generation || currentId !== id) return
      mediaSourceEvents.emit('ended', { sourceId: id })
    })
    adapter.on('closed', () => {
      if (generation !== runtime.generation) return
      runtime.adapter = null
      runtime.state = 'error'
      runtime.error = 'connection_lost'
      emitChanged()
    })
    await adapter.connect({ launch })
    if (generation !== runtime.generation) {
      await adapter.disconnect().catch(() => {})
      return
    }
    runtime.adapter = adapter
    runtime.state = 'connected'
    runtime.error = null
  } catch (error) {
    /*
     * Looking for a player without starting it, and not finding one, is the
     * normal answer while it is closed — at the switch, and on every retry
     * after. It is not a failure: no log line, no red row, just not running.
     * Pressing play still reports it, because that one was asked to launch.
     */
    if (!launch && error instanceof AppError && error.code === 'player_unreachable') {
      if (generation === runtime.generation) {
        runtime.adapter = null
        runtime.state = 'disconnected'
        runtime.error = null
      }
      emitChanged()
      return
    }
    console.error(`[playback] ${runtime.profile.kind} connect failed:`, error)
    if (generation === runtime.generation) {
      runtime.adapter = null
      runtime.state = 'error'
      runtime.error = 'connect_failed'
    }
    emitChanged()
    throw error
  }
  emitChanged()
}

/**
 * Let go of a player deliberately, as opposed to losing it.
 *
 * Closing the built-in picture comes through here: a picture nobody asked for
 * is not a failure, and going through the `closed` path would paint the row
 * red with "connection lost" for something the user just did on purpose.
 */
export async function releaseSource(id: string): Promise<void> {
  await disconnectSource(id)
}

async function disconnectSource(id: string): Promise<void> {
  const runtime = runtimes.get(id)
  if (!runtime || runtime.state === 'disconnected' || runtime.state === 'disconnecting') return
  ++runtime.generation
  const adapter = runtime.adapter
  runtime.adapter = null
  runtime.state = 'disconnecting'
  runtime.error = null
  emitChanged()
  await adapter?.disconnect().catch(() => {})
  runtime.state = 'disconnected'
  emitChanged()
}

export function mediaSourceStatus(): MediaSourceStatus[] {
  return [...runtimes.values()].map((runtime) => {
    const reading = runtime.adapter?.read() ?? EMPTY_READING
    return {
      id: runtime.profile.id,
      name: runtime.profile.name,
      kind: runtime.profile.kind,
      state: runtime.state,
      error: runtime.error,
      capabilities: runtime.adapter?.capabilities ?? capabilitiesOf(runtime.profile.kind),
      path: reading.path,
      playing: reading.paused === false && reading.path !== null,
      current: runtime.profile.id === currentId
    }
  })
}

/** The player in use, once it is actually connected. */
export function activeMediaSource(): { id: string; adapter: MediaSourceAdapter } | null {
  const runtime = currentId === null ? null : runtimes.get(currentId)
  return runtime?.adapter ? { id: runtime.profile.id, adapter: runtime.adapter } : null
}

export function activeReading(): MediaSourceReading {
  return activeMediaSource()?.adapter.read() ?? EMPTY_READING
}

/** Is there a player at all to press play into? */
export function hasCurrentSource(): boolean {
  return currentId !== null
}

export async function disposeMediaSources(): Promise<void> {
  stopRetry()
  await Promise.all([...runtimes.keys()].map((id) => disconnectSource(id)))
}

function stopRetry(): void {
  if (retryDelay) clearTimeout(retryDelay)
  if (retryTimer) clearInterval(retryTimer)
  retryDelay = null
  retryTimer = null
}

/**
 * Keep the current player attached whenever it is running. Attaching only: one
 * that is not running stays that way until the user presses play.
 */
function restartRetry(): void {
  stopRetry()
  if (currentId === null) return
  const scan = (): void => {
    const runtime = currentId === null ? null : runtimes.get(currentId)
    if (!runtime || (runtime.state !== 'disconnected' && runtime.state !== 'error')) return
    void connectSource(runtime.profile.id, false).catch(() => {})
  }
  retryDelay = setTimeout(() => {
    scan()
    retryTimer = setInterval(scan, RETRY_MS)
    retryTimer.unref()
  }, RETRY_DELAY_MS)
  retryDelay.unref()
}

/** Capabilities without an instance: the list is drawn before anything connects. */
export function capabilitiesOf(kind: MediaSourceKind): MediaSourceCapabilities {
  switch (kind) {
    case 'internal':
      // `launch` is what makes pressing play open the picture: there is no
      // program to start, but there is a surface that has to appear.
      return { open: true, seek: true, pause: true, volume: true, launch: true }
    case 'mpv':
      return { open: true, seek: true, pause: true, volume: true, launch: true }
    case 'mpc-hc':
      return { open: true, seek: true, pause: true, volume: true, launch: true }
    case 'heresphere':
      return { open: true, seek: true, pause: true, volume: false, launch: false }
  }
}

let broadcastTimer: NodeJS.Timeout | null = null

/**
 * Status goes out coalesced: connecting a player touches this three times in a
 * row, and the sidebar has no use for the intermediate frames.
 */
function emitChanged(): void {
  if (broadcastTimer) return
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null
    mediaSourceEvents.emit('changed', mediaSourceStatus())
  }, 50)
  broadcastTimer.unref()
}
