import { join } from 'node:path'
import { app } from 'electron'
import { OrganiseQueueFileSchema, type QueuedOp } from '@shared/schemas/organise-queue'
import { atomicWriteJson, readJsonOr } from '../../util/atomic-json'

/**
 * Where the organise page's unfinished edits are kept between runs.
 *
 * Storage only: the queue itself is the page's, since every operation is an
 * IPC call it makes and the order they run in is the order the user made them.
 * Here they survive a quit, so tidying a tag tree can be picked up again.
 *
 * A file that fails to parse is treated as empty. It holds work that has not
 * happened yet, not a record of anything: the taxonomy and the sidecars are
 * both untouched by whatever was in it.
 */

function filePath(): string {
  return join(app.getPath('userData'), 'organise-queue.json')
}

export async function loadQueue(): Promise<QueuedOp[]> {
  const parsed = OrganiseQueueFileSchema.safeParse(await readJsonOr(filePath(), { ops: [] }))
  return parsed.success ? parsed.data.ops : []
}

// One write at a time, so a slow one cannot land on top of a newer one.
let writes: Promise<unknown> = Promise.resolve()

export function saveQueue(ops: QueuedOp[]): Promise<void> {
  const run = writes.then(() => atomicWriteJson(filePath(), { ops }))
  writes = run.catch(() => undefined)
  return run
}
