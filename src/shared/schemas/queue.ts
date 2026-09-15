import { z } from 'zod'

/**
 * The playback queue: what plays after this one.
 *
 * Kept apart from the playback status, which describes the file on screen right
 * now. Ordering is a question the queue answers and the player never asks —
 * which is what lets the player underneath be swapped for one of our own
 * without any of this changing.
 */

export const QueueSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('playlist'), name: z.string() }),
  /** Whatever the grid was showing when playback started. */
  z.object({ kind: z.literal('view') }),
  /**
   * The user's own: assembled card by card out of the library, or a queue that
   * started life as a playlist or a view and has since been changed. Either
   * way it is no longer the thing it came from, and saying its old name would
   * be a lie about what plays next.
   */
  z.object({ kind: z.literal('custom') }),
  /** One file, opened on its own. */
  z.object({ kind: z.literal('single') })
])

export const QueueItemSchema = z.object({
  libraryId: z.uuid(),
  mediaId: z.uuid()
})

export const QueueStateSchema = z.object({
  source: QueueSourceSchema,
  items: z.array(QueueItemSchema),
  /**
   * The stepping cursor: where "next" counts from. Usually the item playing,
   * but not always — taking the playing item out leaves the cursor in the gap
   * it left, so the one that followed is still what plays next. -1 means the
   * front of the queue. What is *playing* comes from `playback:status`, never
   * from here.
   */
  index: z.number().int(),
  shuffle: z.boolean(),
  repeat: z.boolean()
})

export type QueueSource = z.infer<typeof QueueSourceSchema>
export type QueueItem = z.infer<typeof QueueItemSchema>
export type QueueState = z.infer<typeof QueueStateSchema>
