import type { DownloadJob, DownloadState } from '@shared/schemas/download'

/**
 * Jobs that have not finished yet: running, or going to run once their turn,
 * the user, or a host's quota window lets them.
 */
export const UNFINISHED = new Set<DownloadState>(['running', 'pending', 'paused', 'cooling'])

/**
 * The order the queue is shown in: what is downloading now, then what is
 * waiting, then everything else.
 *
 * `jobs` arrives newest first. The first two groups are flipped to oldest
 * first, because that is the order the downloader starts them in — the row
 * under the running ones is the next to go. Finished and failed jobs keep
 * newest first, so the one that just landed is the one in reach.
 */
export function inQueueOrder(jobs: DownloadJob[]): DownloadJob[] {
  const running: DownloadJob[] = []
  const waiting: DownloadJob[] = []
  const rest: DownloadJob[] = []
  for (const job of jobs) {
    if (job.state === 'running') running.push(job)
    else if (UNFINISHED.has(job.state)) waiting.push(job)
    else rest.push(job)
  }
  return [...running.reverse(), ...waiting.reverse(), ...rest]
}
