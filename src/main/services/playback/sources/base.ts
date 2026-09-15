import { EventEmitter } from 'node:events'
import type { MediaSourceEvents } from './port'

/** Typed event plumbing shared by the player adapters. */
export abstract class BaseMediaSource extends EventEmitter {
  override on<K extends keyof MediaSourceEvents>(event: K, listener: MediaSourceEvents[K]): this {
    return super.on(event, listener)
  }
  override off<K extends keyof MediaSourceEvents>(event: K, listener: MediaSourceEvents[K]): this {
    return super.off(event, listener)
  }
  override emit<K extends keyof MediaSourceEvents>(
    event: K,
    ...args: Parameters<MediaSourceEvents[K]>
  ): boolean {
    return super.emit(event, ...args)
  }
}

/**
 * Did the file run out, rather than being paused or stopped by hand?
 *
 * mpv answers this itself. The other players do not, so their adapters ask
 * here: a file that stopped advancing within a second of its own length ran
 * out. The tolerance is generous because the last position a player reports
 * is rarely the very last frame.
 */
export function looksFinished(positionMs: number | null, durationMs: number | null): boolean {
  if (positionMs === null || durationMs === null || durationMs <= 0) return false
  return durationMs - positionMs <= 1000
}

/**
 * The file a player names, as a path on this machine.
 *
 * mpv and MPC-HC report a plain path. HereSphere reports both a path and a
 * `file://` URL, and its URL is written `file://F:/x` — the drive letter sits
 * where the host belongs, which the standard URL parser rejects outright, so
 * the conversion is done here rather than with `fileURLToPath`.
 *
 * Anything that is not a file on this machine (an http URL, a scene id, a
 * path relative to the player's own working directory) returns null: matching
 * nothing is better than matching the wrong video.
 */
export function toLocalPath(reported: string | null | undefined): string | null {
  const trimmed = typeof reported === 'string' ? reported.trim() : ''
  if (!trimmed) return null
  if (!/^file:\/\//i.test(trimmed)) {
    return /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\') ? trimmed : null
  }
  let rest = trimmed.slice('file://'.length)
  try {
    rest = decodeURIComponent(rest)
  } catch {
    // Not percent-encoded, or badly so; the raw text is the better guess.
  }
  const stripped = rest.replace(/^\/+/, '')
  if (/^[a-zA-Z]:/.test(stripped)) return stripped
  // A real host: file://server/share/x is that machine's share.
  return rest.startsWith('/') ? null : `\\\\${rest.replace(/\//g, '\\')}`
}
