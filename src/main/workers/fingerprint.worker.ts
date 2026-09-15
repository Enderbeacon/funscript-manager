import { open } from 'node:fs/promises'
import { blake3 } from 'hash-wasm'
import { servePool } from '../util/worker-pool'

/**
 * Fingerprint worker: size + BLAKE3 of the first 1MB — enough to recognise a
 * file after a move or rename without reading all of it.
 * Runs in a worker thread so large scan batches never block the main loop.
 */

const HEAD_BYTES = 1024 * 1024

export interface FingerprintTask {
  filePath: string
}

export interface FingerprintResult {
  size: number
  blake3Head: string
}

async function compute(filePath: string): Promise<FingerprintResult> {
  const handle = await open(filePath, 'r')
  try {
    const { size } = await handle.stat()
    const buf = Buffer.alloc(Math.min(HEAD_BYTES, size))
    let offset = 0
    while (offset < buf.length) {
      const { bytesRead } = await handle.read(buf, offset, buf.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return { size, blake3Head: await blake3(buf.subarray(0, offset)) }
  } finally {
    await handle.close()
  }
}

servePool<FingerprintTask, FingerprintResult>((task) => compute(task.filePath))
