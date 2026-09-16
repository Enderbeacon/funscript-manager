/** Library-level cache directory (inside the library root; disposable, rebuildable). */
export const LIBRARY_CACHE_DIR = '.fsmgr-cache'

/** Library-wide metadata file (tag hierarchy / performers / studios / playlists). */
export const LIBRARY_JSON = 'library.json'

/**
 * Library state that is NOT derived from anything and cannot be rebuilt by
 * scanning — currently the list of files the user removed from the library
 * while leaving them on disk. It sits at the library root rather than in
 * `.fsmgr-cache/`, because that directory is documented as safe to delete and
 * losing this file would silently re-add everything the user removed.
 * Dot-prefixed, so the scanner's own walk steps over it.
 */
export const LIBRARY_STATE_JSON = '.fsmgr-library.json'

/** Library-level index database file. */
export const INDEX_DB = 'index.db'

/** Sidecar suffix: `<full media filename>.meta.json`. */
export const SIDECAR_SUFFIX = '.meta.json'

/** mpv JSON IPC named-pipe name; the one MultiFunPlayer uses, so both attach to the same mpv. */
export const MPV_PIPE_NAME = 'multifunplayer-mpv'

export const VIDEO_EXTENSIONS = [
  '.mp4', '.mkv', '.webm', '.mov', '.avi', '.wmv', '.m4v', '.ts', '.flv'
] as const

export const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.flac', '.wav', '.opus'] as const

export const SUBTITLE_EXTENSIONS = ['.srt', '.vtt', '.ass', '.ssa'] as const

export const FUNSCRIPT_EXTENSION = '.funscript'

/** Funscript multi-axis infixes (`video.roll.funscript` etc.); order = UI display order. */
export const FUNSCRIPT_AXES = ['roll', 'pitch', 'surge', 'sway', 'twist'] as const
export type FunscriptAxis = (typeof FUNSCRIPT_AXES)[number] | 'main'

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
