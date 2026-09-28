/** Library-level cache directory (inside the library root; disposable, rebuildable). */
export const LIBRARY_CACHE_DIR = '.fsmgr-cache'

/** Library-wide metadata file (tag hierarchy / performers / studios / playlists). */
export const LIBRARY_JSON = 'library.json'

/**
 * The library's own data directory: what cannot be rebuilt by scanning. It is
 * kept apart from `.fsmgr-cache/` because that directory is documented as safe
 * to delete, and nothing in here is. Dot-prefixed, so the scanner's own walk
 * steps over it.
 */
export const LIBRARY_DATA_DIR = '.fsmgr'

/**
 * Library state inside LIBRARY_DATA_DIR: the files the user removed from the
 * library while leaving them on disk, and where the library keeps its sidecars.
 */
export const LIBRARY_STATE_JSON = 'state.json'

/** Where the state file sat before LIBRARY_DATA_DIR existed; moved on first load. */
export const LEGACY_LIBRARY_STATE_JSON = '.fsmgr-library.json'

/**
 * Sidecars kept away from the media, inside LIBRARY_DATA_DIR. The folders under
 * it mirror the library's own, so `a/b/clip.mp4` has its sidecar at
 * `.fsmgr/meta/a/b/clip.mp4.meta.json`.
 */
export const LIBRARY_META_DIR = 'meta'

/** Library-level index database file. */
export const INDEX_DB = 'index.db'

/** Sidecar suffix: `<full media filename>.meta.json`. */
export const SIDECAR_SUFFIX = '.meta.json'

/** mpv JSON IPC named-pipe name; the one MultiFunPlayer uses, so both attach to the same mpv. */
export const MPV_PIPE_NAME = 'multifunplayer-mpv'

export const VIDEO_EXTENSIONS = [
  '.mp4', '.mkv', '.webm', '.mov', '.avi', '.wmv', '.m4v', '.ts', '.flv'
] as const

/**
 * How far every timestamp in a converted stream is pushed forward, in seconds.
 *
 * Some tracks start a little below zero — AAC's encoder delay, a B-frame
 * video's first decode time — and a fragmented MP4 cannot store a negative
 * time, so the muxer would otherwise shift every track by a different amount.
 * Pushing everything forward by a fixed amount keeps them all positive, and
 * the picture takes the same amount back off, so a frame lands exactly where
 * the source puts it.
 */
export const STREAM_TIME_OFFSET_S = 10

export const AUDIO_EXTENSIONS =['.mp3', '.m4a', '.flac', '.wav', '.opus'] as const

export const SUBTITLE_EXTENSIONS = ['.srt', '.vtt', '.ass', '.ssa'] as const

export const FUNSCRIPT_EXTENSION = '.funscript'

/** Funscript multi-axis infixes (`video.roll.funscript` etc.); order = UI display order. */
export const FUNSCRIPT_AXES = ['roll', 'pitch', 'surge', 'sway', 'twist'] as const
export type FunscriptAxis = (typeof FUNSCRIPT_AXES)[number] | 'main'

/**
 * Axis tokens used by funscript authors and device software.
 *
 * The L/R names are the common TCode spellings. Treating `scene.L1.funscript`
 * as a version called "L1" creates six single-axis versions from one set, so
 * every filename parser goes through this table instead of only recognizing
 * the long names.
 */
const FUNSCRIPT_AXIS_TOKENS: Readonly<Record<string, FunscriptAxis>> = {
  main: 'main',
  stroke: 'main',
  l0: 'main',
  surge: 'surge',
  l1: 'surge',
  sway: 'sway',
  l2: 'sway',
  twist: 'twist',
  r0: 'twist',
  roll: 'roll',
  r1: 'roll',
  pitch: 'pitch',
  r2: 'pitch'
}

export function funscriptAxisFromToken(token: string): FunscriptAxis | null {
  return FUNSCRIPT_AXIS_TOKENS[token.trim().toLowerCase()] ?? null
}

/**
 * How hard a scan tries to see a media's name inside a companion's, from the
 * strictest to the loosest. The rules themselves live in
 * services/library/companion-grouping.ts; the list is here because the settings
 * schema and the settings page both need it.
 */
export const COMPANION_MATCH_LEVELS = ['exact', 'separators', 'affixes', 'loose'] as const
export type CompanionMatchLevel = (typeof COMPANION_MATCH_LEVELS)[number]
export const DEFAULT_COMPANION_MATCH: CompanionMatchLevel = 'affixes'

/**
 * The copyright line, shown on the startup card and the About page. A legal
 * notice, so it is the same in every language.
 */
export const COPYRIGHT_NOTICE = 'Copyright © 2026 Enderbeacon'
