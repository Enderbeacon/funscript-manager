import type { MediaSourceKind } from '@shared/schemas/app-config'
import type { MediaSourceCapabilities } from '@shared/schemas/playback'

export type { MediaSourceCapabilities }

/**
 * What a video player has to offer this app.
 *
 * A player is whatever can tell us where it is in a file, and — for most of
 * them — be told to open one. mpv is the one we ship with, not the one the
 * rest of the app is written against: everything above this port asks these
 * questions and no mpv-shaped ones.
 */

/** Everything a player says about itself, sampled at one instant. */
export interface MediaSourceReading {
  /** The file it says it is on; null when it is on nothing. */
  path: string | null
  positionMs: number | null
  durationMs: number | null
  paused: boolean | null
  /** 0–100, or null when the player has no volume of its own to report. */
  volume: number | null
}

export const EMPTY_READING: MediaSourceReading = {
  path: null,
  positionMs: null,
  durationMs: null,
  paused: null,
  volume: null
}

export interface MediaSourceEvents {
  /** It moved to a different file, or to none. */
  'path-changed': (p: { path: string | null }) => void
  /** The file ran out on its own — not a pause, not a user stop. */
  ended: () => void
  /** The connection dropped from the player's side. */
  closed: () => void
}

export interface ConnectOptions {
  /**
   * May this connect start the program?
   *
   * The auto-connect scanner passes false: it runs every few seconds in the
   * background, and a background task that launches a video player is a
   * window appearing on the user's screen for no reason. Clicking connect,
   * and pressing play, pass true — there the user has asked for the player.
   */
  launch: boolean
}

export interface MediaSourceAdapter {
  readonly kind: MediaSourceKind
  readonly capabilities: MediaSourceCapabilities

  /** Attach to the player. Throws an AppError when it cannot be reached. */
  connect(opts: ConnectOptions): Promise<void>
  disconnect(): Promise<void>

  /** Where it is right now. Cheap: callers read this hundreds of times a second. */
  read(): MediaSourceReading

  /** Play this file, optionally resuming at a position (milliseconds). */
  open(path: string, startAtMs: number | null): Promise<void>
  setPaused(paused: boolean): Promise<void>
  seek(positionMs: number): Promise<void>
  setVolume(volume: number): Promise<void>

  on<K extends keyof MediaSourceEvents>(event: K, listener: MediaSourceEvents[K]): unknown
  off<K extends keyof MediaSourceEvents>(event: K, listener: MediaSourceEvents[K]): unknown
}
