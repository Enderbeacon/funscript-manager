/**
 * Application error codes shared across main and renderer.
 *
 * The main process must never produce human-readable message text:
 * it throws AppError with a code (+ optional params), the code crosses
 * the IPC boundary as a serialized marker inside Error.message, and the
 * renderer translates it via the i18n bundle (`errors.<code>`).
 *
 * This module must stay dependency-free (importable from preload).
 */

export const APP_ERROR_CODES = [
  'library_path_invalid',
  'library_already_registered',
  'library_not_found',
  'media_not_found',
  'script_version_not_found',
  'script_version_merge_invalid',
  'script_axis_conflict',
  'script_main_axis_required',
  'taxonomy_unknown_kind',
  'taxonomy_not_found',
  'taxonomy_name_taken',
  'taxonomy_name_required',
  'taxonomy_cycle',
  'script_file_not_found',
  /** Not readable as a funscript: missing, unreadable, or without any actions. */
  'script_unreadable',
  'invalid_file_name',
  'file_exists',
  'invalid_url',
  'download_no_plugin',
  'download_expand_failed',
  'download_not_a_video',
  'scrape_not_a_post',
  'scrape_post_not_found',
  'scrape_login_required',
  'scrape_failed',
  'scrape_rate_limited',
  'mpv_unavailable',
  /** A configured player did not answer where it was expected. */
  'player_unreachable',
  /** Nothing to play into: no player in the list is connected. */
  'no_player_connected',
  /** The file needs converting to play, and ffmpeg will not run. */
  'ffmpeg_unavailable',
  /** ffmpeg ran on the file but produced nothing that can be played. */
  'stream_failed',
  'credential_storage_unavailable',
  'disk_full',
  /** Not a failure to act on: a damaged index was rebuilt and is refilling. */
  'index_rebuilt',
  /** GitHub could not be reached, or answered with something unusable. */
  'update_check_failed',
  /** GitHub's hourly limit for unauthenticated requests from this address. */
  'update_rate_limited',
  'update_download_failed',
  /** This copy was not installed by the updater, so it cannot replace itself. */
  'update_not_supported',
  'update_release_not_found',
  /** A license file shipped with the app is missing, or nothing would open it. */
  'license_unavailable',
  /** MEGAcmd is not where the settings say, or not installed at all. */
  'megacmd_missing',
  /** Downloading or running MEGA's installer failed; the log says which. */
  'megacmd_install_failed',
  /** The VR panel plays into HereSphere, and no HereSphere is in the player list. */
  'vr_no_heresphere',
  'internal_error'
] as const

export type AppErrorCode = (typeof APP_ERROR_CODES)[number]

export type AppErrorParams = Record<string, string | number>

export class AppError extends Error {
  constructor(
    readonly code: AppErrorCode,
    readonly params: AppErrorParams = {}
  ) {
    super(`${APP_ERROR_MARKER}${JSON.stringify({ code, params })}`)
    this.name = 'AppError'
  }
}

/** Renderer-side representation of an AppError received over IPC. */
export class AppIpcError extends Error {
  constructor(
    readonly code: AppErrorCode,
    readonly params: AppErrorParams = {}
  ) {
    super(code)
    this.name = 'AppIpcError'
  }
}

const APP_ERROR_MARKER = 'FSMGR_APP_ERROR:'

/**
 * Extract an AppError payload from an Error message that crossed IPC.
 * Electron prefixes rejected invoke() errors with
 * "Error invoking remote method '...': Error: <message>", so we search
 * for the marker instead of matching the whole string.
 */
export function parseAppError(message: string): { code: AppErrorCode; params: AppErrorParams } | null {
  const idx = message.indexOf(APP_ERROR_MARKER)
  if (idx === -1) return null
  try {
    const parsed = JSON.parse(message.slice(idx + APP_ERROR_MARKER.length))
    if (typeof parsed?.code === 'string') {
      return { code: parsed.code as AppErrorCode, params: parsed.params ?? {} }
    }
  } catch {
    // fall through
  }
  return null
}
