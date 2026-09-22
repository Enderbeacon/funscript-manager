import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { EventEmitter } from 'node:events'
import { AppError } from '@shared/errors'
import type { MediaMeta, ScriptVersion } from '@shared/schemas/media-meta'
import type { ScriptRoute } from '@shared/schemas/app-config'
import { getSettings } from '../config/config-service'
import { findByAbsPath } from '../library/library-manager'
import { readSidecar, sidecarPathFor, writeSidecar } from '../library/sidecar'
import { effectiveScriptFiles } from '../library/script-axes'
import { ensureMfp, type MfpStatus } from './mfp'
import { pluginApply } from './mfp-bridge'
import { prepareSession } from './playback-session'
import { applyRememberedSubtitle } from './subtitles'
import { applyVrFormat } from './vr-format'
import {
  activeMediaSource,
  activeReading,
  configureMediaSources,
  connectCurrent,
  hasCurrentSource,
  mediaSourceEvents,
  setCurrentSource
} from './sources/registry'
import { toLocalPath } from './sources/base'
import type { MediaSourceCapabilities } from './sources/port'
import {
  clearScriptPlayer,
  loadScriptPlayer
} from '@script-player/composition/session'
import type { ScriptPlayerAxis } from '@script-player/shared/config'

/**
 * Playback orchestration.
 *
 * The video is played by the current player — mpv, MPC-HC or HereSphere,
 * whichever the user picked. This module knows none of them; it asks the
 * player list for the current one and speaks to it through one small
 * interface. Pressing play sends the file there; a file the user opened in
 * that player themselves is followed instead, and the script for it is loaded
 * to match.
 *
 * Who drives the *script* is a separate, exclusive choice (settings
 * `playback.scriptRoute`):
 *
 * - `internal` — our own player gets the script. MFP is not staged for, not
 *   launched, not talked to. This is the default and the common path.
 * - `mfp` — scripts are staged into the session dir and pushed to MFP's
 *   plugin; our player has already stood down (`configureScriptPlayer`).
 *
 * They are exclusive because a serial port belongs to one process, and
 * because two players on one script means the device is told two things.
 */

export interface PlayResult {
  /** The player the file was handed to (always the current one). */
  sourceId: string
  /** Which player was handed the script. */
  route: ScriptRoute
  /** Only on the MFP route; null means MFP was never involved. */
  mfp: { status: MfpStatus; pluginServed: boolean } | null
  scriptVersionId: string | null
}

export interface PlaybackStatus {
  mediaId: string | null
  /**
   * Which library the file being played belongs to.
   *
   * Reported here rather than looked up from the queue: the now-playing bar
   * needs it to ask for the title and the artwork, and a bar that could only
   * name what it was playing while the queue happened to agree with it spent
   * half its life blank.
   */
  libraryId: string | null
  /** Script version actually loaded right now (null when playing video only). */
  scriptVersionId: string | null
  positionMs: number | null
  /** How long the file is; null until the player has read it. */
  durationMs: number | null
  paused: boolean | null
  /** The player's own volume, 0–100, or null when it has none. */
  volume: number | null
  /**
   * What the player being followed can do, so the transport controls can be
   * drawn from its abilities instead of from its name.
   */
  capabilities: MediaSourceCapabilities | null
  /** The file being played, even when it is not one of ours. */
  path: string | null
}

export interface PlaybackServiceEvents {
  'playback-changed': (p: { mediaId: string | null }) => void
  /**
   * The file played to its end. Reported, never acted on: what happens next is
   * a question about a queue, and this module does not know there is one.
   */
  'playback-ended': (p: { mediaId: string }) => void
}

class TypedEmitter extends EventEmitter {
  override on<K extends keyof PlaybackServiceEvents>(e: K, l: PlaybackServiceEvents[K]): this {
    return super.on(e, l)
  }
  override emit<K extends keyof PlaybackServiceEvents>(
    e: K,
    ...args: Parameters<PlaybackServiceEvents[K]>
  ): boolean {
    return super.emit(e, ...args)
  }
}

export const playbackEvents = new TypedEmitter()

let currentMediaId: string | null = null
let currentLibraryId: string | null = null
/** Which script version the current playback is driving (null = video only). */
let currentScriptVersionId: string | null = null
/** The file we handed to a player, so following it back is not a surprise. */
let openedPath: string | null = null

/**
 * Absolute source paths of a version's scripts, keyed by axis, with the same
 * library-escape guard as the session stager. Fed to the MFP control plugin.
 */
function resolveVersionScripts(
  libraryRoot: string,
  mediaAbs: string,
  version: ScriptVersion
): Record<string, string> {
  const mediaDir = dirname(mediaAbs)
  const out: Record<string, string> = {}
  for (const [axis, rel] of Object.entries(version.files)) {
    if (!rel) continue
    const src = resolve(mediaDir, rel)
    const relToRoot = relative(libraryRoot, src)
    if (relToRoot.startsWith('..') || isAbsolute(relToRoot)) continue
    out[axis] = src
  }
  return out
}

/** Which version plays: explicit → lastUsed → isDefault → first. */
function pickVersion(meta: MediaMeta, explicitId?: string): ScriptVersion | null {
  const versions = meta.scriptVersions
  if (explicitId) {
    const v = versions.find((x) => x.id === explicitId)
    if (v) return v
  }
  const lastUsed = meta.userMeta.lastUsedScriptVersionId
  return (
    (lastUsed && versions.find((x) => x.id === lastUsed)) ||
    versions.find((x) => x.isDefault) ||
    versions[0] ||
    null
  )
}

/** Take the saved player list and start watching what the current player does. */
export async function initPlayback(): Promise<void> {
  const settings = await getSettings()
  configureMediaSources(settings.playback.sources, settings.playback.currentSourceId)

  // The current player changed file: look at what it is on now.
  mediaSourceEvents.on('path-changed', () => scheduleFollow())
  mediaSourceEvents.on('ended', ({ sourceId }) => {
    // Only the current player gets to end the thing we are playing.
    if (currentMediaId === null || activeMediaSource()?.id !== sourceId) return
    playbackEvents.emit('playback-ended', { mediaId: currentMediaId })
  })
}

/** Settings were saved: apply the edited player list. */
export async function reconfigurePlayers(): Promise<void> {
  const { playback } = await getSettings()
  configureMediaSources(playback.sources, playback.currentSourceId)
}

/**
 * Use another player from now on.
 *
 * The registry pauses and lets go of the one being left; what the new one is
 * already playing is picked up here, so switching to a player with a video
 * open lands on that video rather than on nothing.
 */
export async function switchPlayer(id: string): Promise<void> {
  await setCurrentSource(id)
  scheduleFollow()
}

/**
 * Long enough that a burst of updates from one file change is answered once —
 * a player announces the path, the duration and the position separately —
 * short enough that a video opened by hand gets its script before the first
 * stroke.
 */
const FOLLOW_SETTLE_MS = 350
let followTimer: NodeJS.Timeout | null = null

function scheduleFollow(): void {
  if (followTimer) clearTimeout(followTimer)
  followTimer = setTimeout(() => {
    followTimer = null
    void followActive()
  }, FOLLOW_SETTLE_MS)
  followTimer.unref()
}

/** Nothing recognisable is playing any more. */
function forgetCurrent(): void {
  if (currentMediaId === null) return
  currentMediaId = null
  currentLibraryId = null
  currentScriptVersionId = null
  clearScriptPlayer()
  playbackEvents.emit('playback-changed', { mediaId: null })
}

/**
 * Follow the current player. If it is on a file we did not put there, find that
 * file in the library and load its script, so opening something in mpv or
 * picking a scene in the headset drives the device just like pressing play here
 * does. A file outside every library plays without a script.
 */
async function followActive(): Promise<void> {
  const reported = activeReading().path
  if (reported !== null && openedPath !== null && samePath(reported, openedPath)) return
  openedPath = null
  if (reported === null) {
    forgetCurrent()
    return
  }
  const path = toLocalPath(reported)
  const found = path === null ? null : findByAbsPath(path)
  // One line per file change, because this is the one thing here with no
  // visible symptom when it goes wrong: the device simply does not move, and
  // "which of these three steps failed" is otherwise unanswerable.
  console.log(
    `[playback] player is on ${JSON.stringify(reported)} → ${
      path === null
        ? 'not a local file path'
        : found
          ? `media ${found.mediaId}`
          : 'no media at that path in any library'
    }`
  )
  if (!found) {
    forgetCurrent()
    return
  }
  if (found.mediaId === currentMediaId) return
  const mediaAbs = join(found.libraryRoot, found.mediaRelPath)
  const sidecar = await readSidecar(sidecarPathFor(mediaAbs))
  const version = sidecar.ok ? pickVersion(sidecar.meta) : null
  currentMediaId = found.mediaId
  currentLibraryId = found.libraryId
  currentScriptVersionId = version?.id ?? null
  const route = (await getSettings()).playback.scriptRoute
  if (version && sidecar.ok && route === 'internal') {
    const files = { ...version, files: effectiveScriptFiles(sidecar.meta, version) }
    await loadScriptPlayer(
      found.mediaId,
      version.id,
      resolveVersionScripts(found.libraryRoot, mediaAbs, files) as Partial<
        Record<ScriptPlayerAxis, string>
      >
    )
  } else {
    clearScriptPlayer()
  }
  playbackEvents.emit('playback-changed', { mediaId: found.mediaId })
}

/** Players report paths back in their own spelling; Windows does not care. */
function samePath(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase()
}

/**
 * Start playback of a media file with a chosen (or best-match) script
 * version. `libraryRoot`/`mediaRelPath` come from the library manager.
 */
export async function play(opts: {
  libraryRoot: string
  mediaRelPath: string
  mediaId: string
  /** Only for reporting back in `status`; the file is found by path. */
  libraryId?: string
  scriptVersionId?: string
  /** Play the video alone: no script is handed to either player. */
  noScript?: boolean
  resumePosition?: boolean
}): Promise<PlayResult> {
  const mediaAbs = join(opts.libraryRoot, opts.mediaRelPath)
  const sidecar = await readSidecar(sidecarPathFor(mediaAbs))
  if (!sidecar.ok) throw new AppError('media_not_found')
  const picked = opts.noScript ? null : pickVersion(sidecar.meta, opts.scriptVersionId)
  // A single-axis version may borrow the other axes from the default
  // multi-axis version; the staged session directory and the MFP plugin both
  // get the same effective map.
  const version = picked && { ...picked, files: effectiveScriptFiles(sidecar.meta, picked) }

  const settings = await getSettings()
  const route = settings.playback.scriptRoute

  // Staging copies the scripts under the video's basename so MFP's own
  // filename matching finds them. Nobody else reads that directory, so on the
  // internal route it is pure file copying for an audience of none.
  if (route === 'mfp') await prepareSession(opts.libraryRoot, mediaAbs, version)

  const target = await requireOpenTarget()

  // In-place version switch keeps the current position across the reload.
  // Only when the same media is already playing — a fresh
  // play always starts from the top.
  const reading = target.adapter.read()
  const resumeAt =
    opts.resumePosition && currentMediaId === opts.mediaId ? reading.positionMs : null
  openedPath = mediaAbs
  await target.adapter.open(mediaAbs, resumeAt !== null && resumeAt > 0 ? resumeAt : null)
  if (target.adapter.capabilities.pause) await target.adapter.setPaused(false)
  // Only the picture we draw ourselves has subtitles to put on, or a
  // projection to undo; every other player has its own. The subtitle is not
  // awaited — the video is already going — while the projection is settled
  // here and now, from the sidecar already in hand, so a VR file is never
  // drawn as two halves first.
  if (target.adapter.kind === 'internal') {
    applyVrFormat(sidecar.meta)
    void applyRememberedSubtitle(mediaAbs)
  }

  currentMediaId = opts.mediaId
  currentLibraryId = opts.libraryId ?? null
  currentScriptVersionId = version?.id ?? null
  const scripts = version ? resolveVersionScripts(opts.libraryRoot, mediaAbs, version) : {}
  if (version && route === 'internal') {
    await loadScriptPlayer(
      opts.mediaId,
      version.id,
      scripts as Partial<Record<ScriptPlayerAxis, string>>
    )
  } else {
    clearScriptPlayer()
  }
  playbackEvents.emit('playback-changed', { mediaId: opts.mediaId })

  // Remember the chosen version (sidecar first; the watcher resyncs the index).
  if (version && sidecar.meta.userMeta.lastUsedScriptVersionId !== version.id) {
    const updated: MediaMeta = {
      ...sidecar.meta,
      userMeta: { ...sidecar.meta.userMeta, lastUsedScriptVersionId: version.id },
      updatedAt: new Date().toISOString()
    }
    await writeSidecar(sidecarPathFor(mediaAbs), updated).catch((e) =>
      console.error('[playback] failed to persist lastUsedScriptVersionId:', e)
    )
  }

  // Everything below belongs to the MFP route. On the internal route the user
  // has not asked for MFP at all, so it is never started behind their back.
  if (route !== 'mfp') {
    return { sourceId: target.id, route, mfp: null, scriptVersionId: version?.id ?? null }
  }

  const mfpStatus = await ensureMfp(settings.playback.mfpExePath)

  // Path B: if the control plugin is loaded, push the exact script→axis map so
  // MFP loads our chosen version regardless of its own filename matching, and
  // release the axes this version does not use (video-only sends no scripts at
  // all, so every axis is released). Unreachable plugin → false, and the
  // staged session directory already covers the scripts.
  const pluginServed = await pluginApply(scripts, {
    mediaPath: mediaAbs,
    mfpExePath: settings.playback.mfpExePath
  })

  return {
    sourceId: target.id,
    route,
    mfp: { status: mfpStatus, pluginServed },
    scriptVersionId: version?.id ?? null
  }
}

/**
 * Where the file goes when the user presses play: the current player.
 *
 * If it is not attached yet we attach now, and this is the one moment we may
 * start the program — pressing play is the user asking for their player. One
 * that cannot be started (HereSphere lives in the headset) fails here, and the
 * message says so.
 */
type OpenTarget = NonNullable<ReturnType<typeof activeMediaSource>>

async function requireOpenTarget(): Promise<OpenTarget> {
  const ready = activeMediaSource()
  if (ready) return ready
  if (!hasCurrentSource()) throw new AppError('no_player_connected')
  await connectCurrent(true)
  const connected = activeMediaSource()
  if (!connected) throw new AppError('player_unreachable')
  return connected
}

/**
 * Pause or resume the current playback.
 *
 * Deliberately not a stop: mpv's `stop` unloads the file, and an mpv started
 * by MFP has no `--idle` (checked against MFP 1.32, 2026-07-22), so it would quit
 * outright. Pausing also leaves MFP's media session intact, so resuming needs
 * no reload and the device simply stops moving.
 */
export async function setPaused(paused: boolean): Promise<void> {
  const active = activeMediaSource()
  if (!active?.adapter.capabilities.pause) return
  await active.adapter.setPaused(paused)
}

/** Jump to a position in the file playing now; ignored when nothing is. */
export async function seek(positionMs: number): Promise<void> {
  const active = activeMediaSource()
  if (!active?.adapter.capabilities.seek) return
  await active.adapter.seek(positionMs)
}

/**
 * The player's own volume, which is the one the user hears — deliberately not
 * a second volume of our own multiplied into it, because then turning the
 * player down and turning the app down would be two different things that look
 * the same.
 */
export async function setVolume(volume: number): Promise<void> {
  const active = activeMediaSource()
  if (!active?.adapter.capabilities.volume) return
  await active.adapter.setVolume(volume)
}

export function status(): PlaybackStatus {
  const active = activeMediaSource()
  const reading = activeReading()
  return {
    mediaId: currentMediaId,
    libraryId: currentLibraryId,
    scriptVersionId: currentScriptVersionId,
    positionMs: reading.positionMs,
    durationMs: reading.durationMs,
    paused: reading.paused,
    volume: reading.volume,
    capabilities: active?.adapter.capabilities ?? null,
    path: reading.path
  }
}

/** App shutdown: let go of every player without closing any of them. */
export function disposePlayback(): void {
  currentMediaId = null
  currentLibraryId = null
  currentScriptVersionId = null
  openedPath = null
  clearScriptPlayer()
}
