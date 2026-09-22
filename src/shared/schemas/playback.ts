import { z } from 'zod'
import { MediaSourceKindSchema } from './app-config'
import { FLAT_VR_FORMAT } from '../vr-video'
import { VrFormatSchema, VrLayoutSchema, VrProjectionSchema } from './vr-video'

/**
 * What the renderer is told about the video players.
 *
 * The capability flags exist so screens are drawn from what a player can do
 * rather than from which player it is: no volume control means no volume
 * slider, and the next player added changes no screen.
 */

export const MediaSourceCapabilitiesSchema = z.object({
  /** Can be told which file to play. */
  open: z.boolean(),
  seek: z.boolean(),
  pause: z.boolean(),
  volume: z.boolean(),
  /** We can start the program ourselves rather than waiting for the user. */
  launch: z.boolean()
})

export type MediaSourceCapabilities = z.infer<typeof MediaSourceCapabilitiesSchema>

export const MediaSourceStateSchema = z.enum([
  'disconnected',
  'connecting',
  'connected',
  'disconnecting',
  'error'
])

export type MediaSourceState = z.infer<typeof MediaSourceStateSchema>

export const MediaSourceStatusSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: MediaSourceKindSchema,
  state: MediaSourceStateSchema,
  error: z.enum(['connect_failed', 'connection_lost']).nullable(),
  capabilities: MediaSourceCapabilitiesSchema,
  /** The file it is on, so the row can say what it is playing. */
  path: z.string().nullable(),
  playing: z.boolean(),
  /** The player in use. Exactly one is, and only it is ever connected. */
  current: z.boolean()
})

export type MediaSourceStatus = z.infer<typeof MediaSourceStatusSchema>

/**
 * The built-in picture.
 *
 * The main process holds what should be playing; the `<video>` element is a
 * view of it that reports back. Deliberately a state to match rather than a
 * stream of commands: docking the picture out into its own window destroys
 * the element and builds a new one, and a new element that reads the current
 * state lands in the right place on its own — no command has to be replayed.
 */
/**
 * One subtitle the picture could show.
 *
 * Three ways one turns up, and only the first is free: a file sitting next to
 * the video, which the library already found while scanning; a track inside
 * the video, which costs an ffmpeg run to read out; and one the user pointed
 * at by hand, which may be anywhere.
 */
export const SubtitleTrackSchema = z.object({
  /** Unique within one video, and stable across a reload of the list. */
  id: z.string(),
  origin: z.enum(['companion', 'embedded', 'picked']),
  /** The subtitle file, or — for a track inside the video — the video itself. */
  path: z.string(),
  /** Which stream to read out; null for a file. */
  streamIndex: z.number().int().nonnegative().nullable(),
  /** The marker the file or the stream carried, verbatim. Null = none. */
  language: z.string().nullable(),
  /** What the menu shows. Already readable; the renderer does not build it. */
  label: z.string()
})

export type SubtitleTrack = z.infer<typeof SubtitleTrackSchema>

/** A line and when it is on screen. Styling is the user's, so text is text. */
export const SubtitleCueSchema = z.object({
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  /** Newlines are the only structure kept; everything else is stripped. */
  text: z.string()
})

export type SubtitleCue = z.infer<typeof SubtitleCueSchema>

export const InternalPlayerIntentSchema = z.object({
  /** Is there meant to be a picture at all? False = no surface, nothing playing. */
  active: z.boolean(),
  /**
   * What to show. A path, like every other player is given — the surface turns
   * it into a `fsmgr-media://` source, and that scheme is where the library is
   * consulted. Keeping the lookup there is what stops the player list from
   * depending on the library index.
   */
  media: z
    .object({
      path: z.string(),
      fileName: z.string()
    })
    .nullable(),
  /**
   * Where to be, and a token that changes every time the app asks for it.
   * A seek is an edge, not a level: without the token, seeking back to the
   * position the surface is already at would be indistinguishable from no
   * request at all.
   */
  seekToken: z.number().int().nonnegative(),
  seekMs: z.number().nonnegative(),
  paused: z.boolean(),
  volume: z.number().min(0).max(100),
  /**
   * The subtitle on screen, chosen for this file. Part of the intent rather
   * than something the surface keeps to itself, so popping the picture out
   * into its own window keeps the subtitle that was on.
   */
  subtitle: SubtitleTrackSchema.nullable(),
  /** Nudge, in milliseconds: positive shows the line later. Per file. */
  subtitleOffsetMs: z.number().int(),
  /**
   * How the file on screen is marked: a VR format, or `flat` for an ordinary
   * video or one never marked. Read from the sidecar by the main process.
   */
  vr: VrFormatSchema.default(FLAT_VR_FORMAT)
})

export type InternalPlayerIntent = z.infer<typeof InternalPlayerIntentSchema>

/** What the surface says back, several times a second while it is playing. */
export const InternalPlayerReportSchema = z.object({
  /** Which file this is about; a report about another one arrived late. */
  path: z.string().nullable(),
  positionMs: z.number().nullable(),
  durationMs: z.number().nullable(),
  paused: z.boolean(),
  volume: z.number().min(0).max(100),
  /** The file ran out on its own — not a pause, not a close. */
  ended: z.boolean(),
  /**
   * The picture cannot show this file. `unsupported_format` is the common one:
   * nothing — neither Chromium nor a conversion — could play it.
   * `needs_ffmpeg` is the one the user can fix, by installing it.
   */
  error: z.enum(['unsupported_format', 'load_failed', 'needs_ffmpeg']).nullable()
})

export type InternalPlayerReport = z.infer<typeof InternalPlayerReportSchema>

/**
 * How the picture gets at a file.
 *
 * `direct` hands Chromium the file as it is. `stream` has ffmpeg rewrite it on
 * the fly into something Chromium plays: `copy` keeps the track as it is and
 * only changes the container around it, `encode` converts it. `needs_ffmpeg`
 * is a file that needs that conversion on a machine that cannot run ffmpeg.
 */
export const StreamVideoModeSchema = z.enum(['copy', 'encode'])
export const StreamAudioModeSchema = z.enum(['copy', 'encode', 'none'])

export const VideoRouteSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('direct') }),
  z.object({
    kind: z.literal('stream'),
    video: StreamVideoModeSchema,
    audio: StreamAudioModeSchema,
    /** What the stream's video track is: the source's when copied, H.264 when converted. */
    videoCodec: z.enum(['h264', 'hevc']),
    /** The source's length; a stream cannot tell the element how long it is. */
    durationMs: z.number().nonnegative().nullable(),
    /** What the element's MediaSource is told it will be fed. */
    mimeType: z.string()
  }),
  z.object({ kind: z.literal('needs_ffmpeg') })
])

export type VideoRoute = z.infer<typeof VideoRouteSchema>
export const StreamRouteSchema = VideoRouteSchema.options[1]
export type StreamRoute = z.infer<typeof StreamRouteSchema>

/**
 * Asked for again when the route that was tried did not play: `stream` after a
 * direct load failed, `encode` after a stream that kept a track as it was.
 */
export const VideoRouteFallbackSchema = z.enum(['none', 'stream', 'encode'])
export type VideoRouteFallback = z.infer<typeof VideoRouteFallbackSchema>

/**
 * A change from the picture's menu to how the file on screen is marked. A
 * field left out keeps its current value.
 */
export const VrFormatPatchSchema = z.object({
  projection: VrProjectionSchema.optional(),
  layout: VrLayoutSchema.optional()
})

export type VrFormatPatch = z.infer<typeof VrFormatPatchSchema>
