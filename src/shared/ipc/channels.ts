/**
 * IPC channel allowlist prefixes.
 *
 * Kept as a dependency-free module: the preload script runs sandboxed and
 * cannot require third-party packages, so this file must not import
 * anything (contract.ts re-exports from here).
 */

/** Allowlist prefixes for invoke channels. */
export const IPC_CHANNEL_PREFIXES = [
  'app:',
  'deps:',
  'dialog:',
  'download:',
  'library:',
  /** Finding the forum post an entry came from, one entry or the whole library. */
  'match:',
  'media:',
  'playback:',
  /** Saved playlists, and the queue that plays after this one. */
  'playlist:',
  'queue:',
  'scrape:',
  'script-player:',
  'settings:',
  'sites:',
  'taxonomy:',
  /** Finding, downloading and installing app releases, and the notices shown about them. */
  'updates:',
  /** The built-in picture: the surface holding it, and what it reports back. */
  'video:'
] as const

/** Prefix for main → renderer event channels. */
export const IPC_EVENT_PREFIX = 'event:'
