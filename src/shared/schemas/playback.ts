import { z } from 'zod'
import { MediaSourceKindSchema } from './app-config'

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
  subtitleOffsetMs: z.number().int()
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
   * The picture cannot show this file. `unsupported_format` is the common one
   * and the only one worth a sentence on screen: this build of Chromium has
   * no decoder for it.
   */
  error: z.enum(['unsupported_format', 'load_failed']).nullable()
})

export type InternalPlayerReport = z.infer<typeof InternalPlayerReportSchema>
