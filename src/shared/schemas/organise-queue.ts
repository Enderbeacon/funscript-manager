import { z } from 'zod'
import { ENTITY_KINDS } from './taxonomy'

/**
 * The organise page's unfinished work.
 *
 * Edits there are recorded as operations and run one at a time, because a
 * rename rewrites every sidecar carrying the name and two of them at once
 * would each write back a file computed before the other existed. The list is
 * kept on disk so quitting halfway through tidying a tag tree loses nothing:
 * whatever had not run yet resumes on the next start.
 *
 * The operations name entities rather than pointing at them, exactly as the
 * IPC calls they become do. They are only ever valid in the order they were
 * made — the second one was decided while looking at the result of the first.
 */

const named = { name: z.string().min(1) }

export const OrganiseOpSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create'), ...named }),
  z.object({ type: z.literal('rename'), ...named, to: z.string().min(1) }),
  z.object({ type: z.literal('parent'), ...named, parent: z.string().nullable() }),
  z.object({ type: z.literal('aliases'), ...named, aliases: z.array(z.string()) }),
  z.object({ type: z.literal('description'), ...named, description: z.string() }),
  z.object({ type: z.literal('merge'), ...named, into: z.string().min(1) }),
  z.object({ type: z.literal('delete'), ...named })
])

export const QueuedOpSchema = z.intersection(
  OrganiseOpSchema,
  z.object({ id: z.number().int().nonnegative(), kind: z.enum(ENTITY_KINDS) })
)

export const OrganiseQueueFileSchema = z.object({
  ops: z.array(QueuedOpSchema).default([])
})

export type OrganiseAction = z.infer<typeof OrganiseOpSchema>
export type QueuedOp = z.infer<typeof QueuedOpSchema>
