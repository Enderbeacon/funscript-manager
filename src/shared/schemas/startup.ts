import { z } from 'zod'

/**
 * What the startup card says while the app gets itself ready.
 *
 * The main process reports a step, never a sentence: the card translates it,
 * the same way the rest of the app translates error codes.
 */

export const StartupStepSchema = z.enum([
  /** Settings and the proxy — local, over in milliseconds. */
  'starting',
  /** This run is the release that was just installed. */
  'updated',
  /** Asking about newer releases and notices, with a deadline. */
  'updates',
  /** A library's first index pass, with a deadline of its own. */
  'library',
  /** The window is loading; it appears once it has drawn something. */
  'window',
  /** Leaving, so the updater can replace the files. */
  'installing'
])

export const StartupStatusSchema = z.object({
  step: StartupStepSchema,
  /** How far through the whole sequence, 0–100. */
  progress: z.number().min(0).max(100),
  /** The library being scanned, while the step is `library`. */
  library: z.string().nullable(),
  /** Files done / files found in that library; 0 until the count is known. */
  processed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  /** The release just installed, while the step is `updated`. */
  version: z.string().nullable()
})

export type StartupStep = z.infer<typeof StartupStepSchema>
export type StartupStatus = z.infer<typeof StartupStatusSchema>
