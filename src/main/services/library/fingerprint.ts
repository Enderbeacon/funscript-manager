import { cpus } from 'node:os'
import type { FileFingerprint } from '@shared/schemas/media-meta'
import { WorkerPool } from '../../util/worker-pool'
import type { FingerprintTask, FingerprintResult } from '../../workers/fingerprint.worker'
import fingerprintWorkerPath from '../../workers/fingerprint.worker?modulePath'

/**
 * Worker-thread pool for fingerprint computation.
 * Hashing 1MB is cheap but scan batches touch thousands of files; the pool
 * keeps disk reads parallel and off the main thread.
 */

const POOL_SIZE = Math.min(4, Math.max(1, cpus().length - 1))

let pool: WorkerPool<FingerprintTask, FingerprintResult> | null = null

/** Compute size + BLAKE3-of-first-1MB for a file, in a shared worker pool. */
export function computeFingerprint(filePath: string): Promise<FileFingerprint> {
  pool ??= new WorkerPool(fingerprintWorkerPath, POOL_SIZE, 'fingerprint')
  return pool.run({ filePath })
}

/** Terminate all workers (app shutdown). */
export async function disposeFingerprintPool(): Promise<void> {
  const p = pool
  pool = null
  await p?.dispose()
}
