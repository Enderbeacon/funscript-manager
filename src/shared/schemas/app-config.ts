import { z } from 'zod'
import { COMPANION_MATCH_LEVELS, DEFAULT_COMPANION_MATCH } from '../constants'
import { QUALITY_CHOICES } from '../quality'
import { UpdateChannelSchema } from './updates'
import { ScriptPlayerSettingsSchema } from '../../script-player/shared/config'

/**
 * App-level configuration: settings.json and libraries.json under
 * `%APPDATA%/funscript-manager/`.
 */

/**
 * The colours a user may set, and the CSS variable each one drives. These are
 * the *seeds* of themes.css — fills, borders, glass edges and soft states are
 * mixed from them at paint time, so this list stays short on purpose.
 *
 * Values are plain CSS colours a swatch picker can produce (`#rrggbb`);
 * translucency belongs to the derivation, not to what the user types.
 */
export const PALETTE_SEEDS = {
  bgPage: '--bg-page',
  surface: '--surface',
  textPrimary: '--text-primary',
  accent: '--accent',
  gradA: '--grad-a',
  gradB: '--grad-b',
  blob1: '--blob-1',
  blob2: '--blob-2',
  blob3: '--blob-3',
  danger: '--danger',
  success: '--success',
  warn: '--warn'
} as const

export type PaletteSeed = keyof typeof PALETTE_SEEDS

export const PaletteOverrideSchema = z.partialRecord(
  z.enum(Object.keys(PALETTE_SEEDS) as [PaletteSeed, ...PaletteSeed[]]),
  z.string()
)

export type PaletteOverride = z.infer<typeof PaletteOverrideSchema>

/**
 * Who drives the funscript. The two are exclusive — see the `scriptRoute`
 * field on the settings schema below.
 */
export const ScriptRouteSchema = z.enum(['internal', 'mfp'])
export type ScriptRoute = z.infer<typeof ScriptRouteSchema>

/**
 * The video players this app can drive and follow.
 *
 * `internal` is the picture this app draws itself. It is a player like the
 * others — one entry in the list, current or not — so that nothing above the
 * player port has to know whether the video is in our window or someone
 * else's.
 */
export const MediaSourceKindSchema = z.enum(['internal', 'mpv', 'mpc-hc', 'heresphere'])
export type MediaSourceKind = z.infer<typeof MediaSourceKindSchema>

/**
 * One video player the user has added, the same way outputs are added.
 *
 * Fields not belonging to the chosen kind are simply unused — a flat profile
 * keeps the list one type rather than a union the settings file has to be
 * migrated through every time a player is added.
 */
export const MediaSourceProfileSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  kind: MediaSourceKindSchema,
  /** mpv: executable path. Empty = the bundled build, then PATH. */
  exePath: z.string().default(''),
  /** MPC-HC / HereSphere: where to reach the player. */
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(13579)
})

export type MediaSourceProfile = z.infer<typeof MediaSourceProfileSchema>

/**
 * The two players a fresh install starts with: the built-in picture, and mpv,
 * the one we ship for everything the built-in cannot decode.
 *
 * The ids are fixed rather than generated: a generated id is a new id on every
 * read of a settings file that predates the entry, and a row whose identity
 * changed under the sidebar is a row that disconnects itself.
 */
export const BUILT_IN_SOURCE_ID = '696e7472-0000-4000-8000-000000000001'
export const DEFAULT_MPV_SOURCE_ID = '6d70762d-0000-4000-8000-000000000001'

/** The built-in player, which is not configured and cannot be removed. */
export function builtInMediaSource(): MediaSourceProfile {
  return {
    id: BUILT_IN_SOURCE_ID,
    name: 'Built-in player',
    kind: 'internal',
    exePath: '',
    host: '127.0.0.1',
    port: 13579
  }
}

export function defaultMediaSources(): MediaSourceProfile[] {
  return [
    builtInMediaSource(),
    { id: DEFAULT_MPV_SOURCE_ID, name: 'mpv', kind: 'mpv', exePath: '', host: '127.0.0.1', port: 13579 }
  ]
}

/**
 * The built-in player is always in the list, at the top.
 *
 * It is not something the user added, so it cannot be missing: settings files
 * written before it existed have a list without it, and the remove button
 * refuses it. Enforcing that here rather than at each call site means every
 * read and every write of the settings comes back with it present.
 */
function withBuiltInSource(sources: MediaSourceProfile[]): MediaSourceProfile[] {
  const rest = sources.filter((source) => source.kind !== 'internal')
  const existing = sources.find((source) => source.kind === 'internal')
  return [existing ?? builtInMediaSource(), ...rest]
}

export const RegisteredLibrarySchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  rootPath: z.string().min(1),
  addedAt: z.iso.datetime()
})

export const LibrariesFileSchema = z.object({
  libraries: z.array(RegisteredLibrarySchema).default([])
})

export const SettingsSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  /** Built-in funscript output engine. Connections are opt-in and restored disconnected. */
  scriptPlayer: ScriptPlayerSettingsSchema,
  playback: z
    .object({
      /**
       * Who drives the script: our own player, or MultiFunPlayer.
       *
       * The two are exclusive. Both reach for the same serial port, and until
       * this setting existed both ran at once. `internal` also keeps MFP out
       * of sight entirely: it is never launched, never polled for, and its
       * settings stay folded away.
       */
      scriptRoute: ScriptRouteSchema.default('internal'),
      /** MFP executable path (empty = unset, triggers auto-detection). */
      mfpExePath: z.string().default(''),
      /** The video players, in the order they are shown; built-in one first. */
      sources: z
        .array(MediaSourceProfileSchema)
        .prefault(defaultMediaSources())
        .transform(withBuiltInSource),
      /**
       * The one being used. Exactly one player is live at a time: two players
       * open on the same video is two answers to "where are we", and the app
       * would have to pick one anyway. Switching pauses and lets go of the old
       * one before taking up the new.
       */
      currentSourceId: z.string().default(BUILT_IN_SOURCE_ID),
      /**
       * Does closing the picture stop playback?
       *
       * Off, closing unloads the video. On, the picture goes away and the
       * sound carries on — the now-playing bar still has it, and its artwork
       * brings the picture back. Only the built-in player can do this; another
       * player's window is not ours to hide.
       */
      keepPlayingWhenClosed: z.boolean().default(false),
      /** Global device sync offset in milliseconds. */
      syncOffsetMs: z.number().int().min(-500).max(500).default(0),
      /**
       * Subtitles: how they look, and what to do with the next video.
       *
       * The look is one setting for the whole app rather than per file —
       * someone who needs bigger text needs it on everything — and the choice
       * of track is remembered as a language, not as a file: the next video
       * has different files but usually the same languages.
       */
      subtitles: z
        .object({
          /**
           * Was a subtitle on last time? A video with nothing matching still
           * starts with none, so this is a preference and not a promise.
           */
          on: z.boolean().default(false),
          /**
           * The language marker last chosen, verbatim. Empty means the track
           * carried no marker — the plain `video.srt` case, which is one
           * choice among several and not the same as "no preference".
           */
          language: z.string().default(''),
          /** Text height as a percentage of the picture's height. */
          fontScale: z.number().min(2).max(12).default(4.4),
          color: z.string().default('#ffffff'),
          /** Text opacity, percent. Separate from the box behind it. */
          opacity: z.number().min(20).max(100).default(100),
          /** The box behind the text. Off leaves the outline doing the work. */
          background: z.boolean().default(true),
          backgroundOpacity: z.number().min(0).max(100).default(55),
          /** How far above the bottom edge the text sits, percent of height. */
          bottomOffset: z.number().min(0).max(40).default(6)
        })
        .prefault({})
    })
    .prefault({}),
  download: z
    .object({
      globalConcurrency: z.number().int().min(1).max(10).default(3),
      /**
       * The resolution to aim for, not a ceiling: a source without it is asked
       * for the next one **up**, and only for a lower one when there is nothing
       * above (see shared/quality.ts).
       */
      preferredQuality: z.enum(QUALITY_CHOICES).default('best'),
      /**
       * Which of a post's links get checked for being alive without being
       * asked. `cheap` is the middle setting: sources that answer in one
       * request are checked, the ones needing a page parse, a browser window
       * or a yt-dlp run wait to be asked (see downloaders/link-check.ts).
       */
      linkCheck: z.enum(['all', 'cheap', 'off']).default('all'),
      /**
       * HTTP proxy for everything the app fetches (downloads, the forum, site
       * pages, binary updates). `http://host:port`, with credentials in the URL
       * when the proxy wants them. Empty = the system proxy.
       *
       * HTTP only: Chromium would take a SOCKS URL, but the download path runs
       * on Node's fetch, which would quietly go direct — one proxy setting that
       * covers half the app is worse than none.
       */
      proxyUrl: z.string().default(''),
      /**
       * Transfer ceiling. `perTask` caps each running download; `total` caps
       * the app. yt-dlp is a separate process that can only limit itself, so in
       * `total` mode it gets an equal share of the ceiling — an approximation,
       * unlike the app's own transfers, which share one bucket.
       */
      rateLimit: z
        .object({
          mode: z.enum(['off', 'perTask', 'total']).default('off'),
          bytesPerSec: z.number().int().min(0).default(0)
        })
        .prefault({}),
      /**
       * gofile's anti-bot website token. Its derivation salt rotates
       * every 6–12 months, so all three are user-settable: `configUrl` fetches
       * `{ salt, websiteToken }` as JSON, `salt` feeds the built-in derivation,
       * and `websiteToken` skips derivation entirely. Empty = use the built-in
       * salt. Precedence: websiteToken > salt > remote config > built-in.
       */
      gofile: z
        .object({
          websiteToken: z.string().default(''),
          salt: z.string().default(''),
          configUrl: z.string().default('')
        })
        .prefault({})
    })
    .prefault({}),
  /**
   * External binaries the app installs and updates itself (yt-dlp, ffmpeg).
   * Both paths override the managed copy for users who keep their own; both
   * URLs replace the GitHub download when a mirror is faster.
   */
  dependencies: z
    .object({
      ytdlpPath: z.string().default(''),
      ytdlpUrl: z.string().default(''),
      ffmpegPath: z.string().default(''),
      ffmpegUrl: z.string().default('')
    })
    .prefault({}),
  library: z
    .object({
      /**
       * How far a scan will go to decide that a funscript belongs to a video
       * sitting next to it. Levels are tried in order and stop at the first
       * that finds anything, so a looser setting
       * only ever gets a say over scripts the tighter rules gave up on — and a
       * script two videos claim equally well is left to neither.
       *
       * `affixes` is the default because it is the widest level that never
       * disagreed with the strict rule when both were measured on a real
       * library; `loose` is offered for people whose scripts and videos are
       * named further apart, and it does sometimes pick the wrong one.
       */
      companionMatch: z.enum(COMPANION_MATCH_LEVELS).default(DEFAULT_COMPANION_MATCH)
    })
    .prefault({}),
  updates: z
    .object({
      /**
       * `beta` also receives stable releases — whichever is newer — so leaving
       * beta never strands anyone on an old prerelease.
       */
      channel: UpdateChannelSchema.default('stable'),
      /** Look for updates and notices on startup and every few hours. */
      autoCheck: z.boolean().default(true),
      /** "Skip this version": not offered again until a newer one appears. */
      skippedVersion: z.string().default('')
    })
    .prefault({}),
  ui: z
    .object({
      theme: z.enum(['system', 'light', 'dark']).default('system'),
      /** UI language; 'system' resolves from the OS locale in the renderer. */
      language: z.enum(['system', 'en', 'zh-CN', 'ja', 'fr', 'de']).default('system'),
      /**
       * Closing the main window, with a player in a window of its own.
       *
       * The picture and the script player can be popped out, and closing the
       * main window used to take them with it — including a video someone was
       * still watching. So it asks, and remembers the answer if told to:
       * `closePlayers` is the old behaviour, `keepPlayers` leaves them running
       * with no main window (starting the app again brings it back).
       */
      onCloseMainWindow: z.enum(['ask', 'closePlayers', 'keepPlayers']).default('ask'),
      /** Media page layout: icon grid or detailed list. */
      mediaView: z.enum(['grid', 'list']).default('grid'),
      /** Last library shown on the media page; empty means all libraries. */
      mediaLibraryId: z.union([z.uuid(), z.literal('')]).default(''),
      /** Artwork shown while the application starts. */
      startupArtwork: z
        .object({
          mode: z.enum(['default', 'library', 'custom']).default('default'),
          customPath: z.string().default(''),
          /** Seconds between library preview changes on the startup card. */
          intervalSeconds: z.number().int().min(1).max(60).default(6),
          /** Library previews use the prepared portrait crop as full-bleed artwork by default. */
          libraryPresentation: z.enum(['cover', 'framed']).default('cover'),
          /** Custom art keeps the historical full-bleed default. */
          customPresentation: z.enum(['cover', 'framed']).default('cover'),
          /** Any selected tag, playlist or folder can supply a video preview. */
          tags: z.array(z.string()).default([]),
          playlists: z.array(z.string()).default([]),
          /** Folder references include their library id and match descendants. */
          folders: z.array(z.string()).default([])
        })
        .prefault({}),
      /** Last general media sort. Playlist order only exists with its filter. */
      mediaSort: z
        .enum(['path', 'title', 'addedAt', 'updatedAt', 'size', 'rating', 'scriptCount'])
        .default('path'),
      /** Last library chosen as the destination on the Posts page. */
      postDownloadLibraryId: z.union([z.uuid(), z.literal('')]).default(''),
      /**
       * Per-theme overrides for the palette seeds in themes.css. Only seeds
       * are settable: every other token mixes from them, so twelve colours
       * restyle the whole app and can never fall out of step with each other.
       * A missing key means "use the built-in value" — the object is sparse so
       * a future default change still reaches users who only re-tinted one
       * colour.
       */
      palette: z
        .object({
          light: PaletteOverrideSchema.prefault({}),
          dark: PaletteOverrideSchema.prefault({})
        })
        .prefault({}),
      /**
       * What the guided tour has already shown this user.
       *
       * `seen` is a plain string list rather than an enum of the sections that
       * exist today: a section renamed in a later release would otherwise fail
       * the parse and take the whole settings file down with it. The renderer
       * ignores ids it does not recognise.
       */
      tour: z
        .object({
          /** The welcome card has been answered, one way or the other. */
          welcomed: z.boolean().default(false),
          /** Nothing starts on its own any more; the top bar still offers it. */
          skipAll: z.boolean().default(false),
          /** Sections finished or skipped, so they do not come back by themselves. */
          seen: z.array(z.string()).default([])
        })
        .prefault({})
    })
    .prefault({})
})

export type RegisteredLibrary = z.infer<typeof RegisteredLibrarySchema>
export type LibrariesFile = z.infer<typeof LibrariesFileSchema>
export type Settings = z.infer<typeof SettingsSchema>

export function defaultSettings(): Settings {
  return SettingsSchema.parse({})
}
