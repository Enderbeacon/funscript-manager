import { z } from 'zod'

/**
 * Deleting and renaming media: the shapes the confirmation dialogs are built
 * from. Both operations are described before they run, because both touch the
 * user's own files and a dialog that cannot name what it is about to do is not
 * a confirmation.
 */

export const FileKindSchema = z.enum(['media', 'script', 'subtitle', 'sidecar'])

export const DeleteModeSchema = z.enum([
  /** Files to the Recycle Bin, entry gone. */
  'files',
  /** Files stay on disk; the library forgets them and will not re-add them. */
  'library'
])

export const DeletePlanSchema = z.object({
  entries: z.array(
    z.object({
      mediaId: z.uuid(),
      title: z.string().nullable(),
      fileName: z.string(),
      wanted: z.boolean(),
      fileMissing: z.boolean()
    })
  ),
  files: z.array(z.object({ path: z.string(), kind: FileKindSchema })),
  /**
   * Companion files an entry outside the selection also names. Listed so the
   * dialog can say so, and left on disk whatever the user answers: one entry's
   * delete never breaks another entry.
   */
  shared: z.array(
    z.object({
      path: z.string(),
      usedBy: z.array(
        z.object({ mediaId: z.uuid(), title: z.string().nullable(), mediaPath: z.string() })
      )
    })
  ),
  companions: z.array(z.string()),
  /** At least one entry has scripts that could stay behind as a placeholder. */
  canKeepScripts: z.boolean()
})

export const RenamePlanSchema = z.object({
  items: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      kind: FileKindSchema,
      /** Present when the file keeps its name, and why. */
      skipped: z.enum(['shared', 'elsewhere', 'unrelated']).optional()
    })
  ),
  /** Names already taken in that folder; the rename refuses rather than overwrite. */
  collides: z.array(z.string())
})

export type FileKind = z.infer<typeof FileKindSchema>
export type DeleteMode = z.infer<typeof DeleteModeSchema>
export type DeletePlan = z.infer<typeof DeletePlanSchema>
export type RenamePlan = z.infer<typeof RenamePlanSchema>
