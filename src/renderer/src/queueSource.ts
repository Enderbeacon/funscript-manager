import type { TFunction } from 'i18next'
import type { QueueState } from '@shared/schemas/queue'

/**
 * What to call the queue on screen.
 *
 * A queue started from a playlist is named after it, right up until the user
 * changes it — at which point the main process stops calling it that list, and
 * this says so. See the `custom` source on QueueState.
 */
export function describeQueueSource(queue: QueueState | null, t: TFunction): string {
  if (!queue) return ''
  if (queue.source.kind === 'playlist') return queue.source.name
  if (queue.source.kind === 'view') return t('queue.fromView')
  if (queue.source.kind === 'custom') return t('queue.custom')
  return t('queue.single')
}
